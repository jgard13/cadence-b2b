import {
  ExecutionMode,
  ExecutionStatus,
  Frequency,
  ScheduleStatus,
} from "@prisma/client";
import prisma from "../db.server";
import {
  checkLocationOverdueOrders,
  completeDraftOrderNetTerms,
  createB2BDraftOrder,
  formatUserErrors,
  sendDraftOrderInvoice,
  type AdminClient,
} from "./shopifyB2B.server";

const IDEMPOTENCY_WINDOW_MS = 12 * 60 * 60 * 1000;

export type ExecuteScheduleOutcome =
  | "SUCCESS"
  | "SKIPPED_OVERDUE"
  | "SKIPPED_IDEMPOTENT"
  | "FAILED"
  | "NOT_FOUND";

export interface ExecuteScheduleResult {
  ok: boolean;
  status: ExecuteScheduleOutcome;
  message: string;
  draftOrderId?: string | null;
  draftOrderName?: string | null;
  orderId?: string | null;
  orderName?: string | null;
  overdueOrderNames?: string[];
}

function formatUtcYyyymmdd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function computeNextRunAt(
  fromDate: Date,
  frequency: Frequency,
  intervalDays?: number | null,
): Date {
  const next = new Date(fromDate.getTime());

  switch (frequency) {
    case Frequency.WEEKLY:
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case Frequency.BIWEEKLY:
      next.setUTCDate(next.getUTCDate() + 14);
      return next;
    case Frequency.MONTHLY: {
      const targetYear = next.getUTCFullYear();
      const targetMonth = next.getUTCMonth() + 1;
      const originalDay = next.getUTCDate();
      // Clamp day to the last day of the target month to avoid overflow (e.g. Jan 31 -> Feb 28/29)
      const lastDayOfTargetMonth = new Date(
        Date.UTC(targetYear, targetMonth + 1, 0),
      ).getUTCDate();
      next.setUTCDate(1);
      next.setUTCMonth(targetMonth);
      next.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
      return next;
    }
    case Frequency.CUSTOM_DAYS: {
      const days =
        typeof intervalDays === "number" && intervalDays > 0
          ? Math.floor(intervalDays)
          : 30;
      next.setUTCDate(next.getUTCDate() + days);
      return next;
    }
    default:
      next.setUTCDate(next.getUTCDate() + 30);
      return next;
  }
}

export async function executeSchedule(
  admin: AdminClient,
  scheduleId: string,
  isManualTest = false,
): Promise<ExecuteScheduleResult> {
  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    include: { lineItems: true },
  });

  if (!schedule) {
    return {
      ok: false,
      status: "NOT_FOUND",
      message: "Recurring schedule not found.",
    };
  }

  const now = new Date();

  // 1. Idempotency check (for scheduled/automated runs)
  if (!isManualTest && schedule.lastRunAt) {
    const elapsedMs = now.getTime() - schedule.lastRunAt.getTime();
    if (elapsedMs < IDEMPOTENCY_WINDOW_MS) {
      return {
        ok: true,
        status: "SKIPPED_IDEMPOTENT",
        message: "Skipped: schedule already executed within the last 12 hours.",
      };
    }
  }

  if (schedule.lineItems.length === 0) {
    const errorMessage = "Schedule has no line items configured.";
    await prisma.executionLog.create({
      data: {
        scheduleId: schedule.id,
        shop: schedule.shop,
        status: ExecutionStatus.FAILED,
        errorMessage,
      },
    });
    return {
      ok: false,
      status: "FAILED",
      message: errorMessage,
    };
  }

  let draftOrderId: string | null = null;
  let draftOrderName: string | null = null;
  let orderId: string | null = null;
  let orderName: string | null = null;

  try {
    // 2. Overdue invoice hold check
    if (schedule.pauseOnOverdue) {
      const overdueCheck = await checkLocationOverdueOrders(
        admin,
        schedule.companyLocationId,
      );

      if (overdueCheck.hasOverdue) {
        const overdueOrderNames = overdueCheck.overdueOrders.map((o) => o.name);
        const orderRefs = overdueOrderNames.join(", ");
        const holdMessage = `Held due to overdue invoice(s) on ${schedule.companyLocationName}: ${orderRefs}`;

        await prisma.$transaction([
          prisma.recurringSchedule.update({
            where: { id: schedule.id },
            data: { status: ScheduleStatus.OVERDUE_HOLD },
          }),
          prisma.executionLog.create({
            data: {
              scheduleId: schedule.id,
              shop: schedule.shop,
              status: ExecutionStatus.SKIPPED_OVERDUE,
              errorMessage: holdMessage,
            },
          }),
        ]);

        return {
          ok: false,
          status: "SKIPPED_OVERDUE",
          message: holdMessage,
          overdueOrderNames,
        };
      }
    }

    // 3. Create B2B Draft Order
    const trimmedPrefix = schedule.poNumberPrefix?.trim();
    const poNumber = trimmedPrefix
      ? `${trimmedPrefix}-${formatUtcYyyymmdd(now)}`
      : null;

    const draftResult = await createB2BDraftOrder(admin, {
      companyId: schedule.companyId,
      companyLocationId: schedule.companyLocationId,
      companyContactId: schedule.companyContactId,
      lineItems: schedule.lineItems.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
      })),
      tags: ["cadence-b2b", "recurring-order"],
      note: schedule.note,
      poNumber,
    });

    if (draftResult.userErrors.length > 0 || !draftResult.draftOrderId) {
      const errorMessage =
        draftResult.userErrors.length > 0
          ? formatUserErrors(draftResult.userErrors)
          : "Shopify did not return a Draft Order ID.";

      await prisma.executionLog.create({
        data: {
          scheduleId: schedule.id,
          shop: schedule.shop,
          status: ExecutionStatus.FAILED,
          errorMessage,
        },
      });

      return {
        ok: false,
        status: "FAILED",
        message: errorMessage,
      };
    }

    draftOrderId = draftResult.draftOrderId;
    draftOrderName = draftResult.draftOrderName;
    const draftOrderLabel = draftOrderName || draftOrderId;

    // 4. Follow-up step based on executionMode
    let successMessage = `Draft order ${draftOrderLabel} created.`;

    if (schedule.executionMode === ExecutionMode.SEND_INVOICE) {
      const invoiceResult = await sendDraftOrderInvoice(admin, draftOrderId);
      if (invoiceResult.userErrors.length > 0) {
        const errorMessage = formatUserErrors(invoiceResult.userErrors);
        await prisma.executionLog.create({
          data: {
            scheduleId: schedule.id,
            shop: schedule.shop,
            status: ExecutionStatus.FAILED,
            shopifyDraftOrderId: draftOrderId,
            errorMessage,
          },
        });
        return {
          ok: false,
          status: "FAILED",
          message: errorMessage,
          draftOrderId,
          draftOrderName,
        };
      }
      if (invoiceResult.draftOrderName) {
        draftOrderName = invoiceResult.draftOrderName;
      }
      successMessage = `Draft order ${draftOrderName || draftOrderLabel} created and invoice sent.`;
    } else if (schedule.executionMode === ExecutionMode.COMPLETE_NET_TERMS) {
      const completeResult = await completeDraftOrderNetTerms(
        admin,
        draftOrderId,
      );
      if (completeResult.userErrors.length > 0) {
        const errorMessage = formatUserErrors(completeResult.userErrors);
        await prisma.executionLog.create({
          data: {
            scheduleId: schedule.id,
            shop: schedule.shop,
            status: ExecutionStatus.FAILED,
            shopifyDraftOrderId: draftOrderId,
            errorMessage,
          },
        });
        return {
          ok: false,
          status: "FAILED",
          message: errorMessage,
          draftOrderId,
          draftOrderName,
        };
      }
      orderId = completeResult.orderId;
      orderName = completeResult.orderName;
      const orderLabel = orderName || orderId || draftOrderLabel;
      successMessage = `Order ${orderLabel} completed with payment pending (Net Terms).`;
    }

    // 5. Record SUCCESS execution log
    await prisma.executionLog.create({
      data: {
        scheduleId: schedule.id,
        shop: schedule.shop,
        status: ExecutionStatus.SUCCESS,
        shopifyDraftOrderId: draftOrderId,
        shopifyOrderId: orderId,
      },
    });

    // 6. Update schedule timestamps on non-test successful runs
    if (!isManualTest) {
      const nextRunAt = computeNextRunAt(
        now,
        schedule.frequency,
        schedule.intervalDays,
      );
      await prisma.recurringSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: now,
          nextRunAt,
        },
      });
    }

    return {
      ok: true,
      status: "SUCCESS",
      message: isManualTest ? `[Test Run] ${successMessage}` : successMessage,
      draftOrderId,
      draftOrderName,
      orderId,
      orderName,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unexpected error while executing recurring schedule.";

    await prisma.executionLog.create({
      data: {
        scheduleId: schedule.id,
        shop: schedule.shop,
        status: ExecutionStatus.FAILED,
        shopifyDraftOrderId: draftOrderId,
        shopifyOrderId: orderId,
        errorMessage,
      },
    });

    return {
      ok: false,
      status: "FAILED",
      message: errorMessage,
      draftOrderId,
      draftOrderName,
      orderId,
      orderName,
    };
  }
}
