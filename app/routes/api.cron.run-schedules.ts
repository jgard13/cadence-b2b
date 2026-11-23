import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ScheduleStatus } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { executeSchedule } from "../services/scheduleRunner.server";
import {
  sendExecutionFailedEmail,
  sendOrderExecutedEmail,
  sendOverdueHoldEmail,
} from "../services/notifications.server";

function verifyBearerToken(
  authHeader: string | null,
  expectedSecret: string,
): boolean {
  if (!authHeader) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return false;
  }

  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedSecret, "utf8");

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

async function handleRunDueSchedules(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    console.error("[CadenceB2B Cron] CRON_SECRET is not configured.");
    return Response.json(
      { error: "CRON_SECRET is not configured on the server." },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("Authorization");
  if (!verifyBearerToken(authHeader, cronSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();

  const dueSchedules = await prisma.recurringSchedule.findMany({
    where: {
      status: ScheduleStatus.ACTIVE,
      nextRunAt: { lte: now },
    },
    orderBy: [{ shop: "asc" }, { nextRunAt: "asc" }],
  });

  if (dueSchedules.length === 0) {
    return Response.json({
      processed: 0,
      succeeded: 0,
      overdueHolds: 0,
      failed: 0,
      durationMs: Date.now() - startedAt,
    });
  }

  // Group due schedules by shop
  const schedulesByShop = new Map<string, typeof dueSchedules>();
  for (const schedule of dueSchedules) {
    const existing = schedulesByShop.get(schedule.shop);
    if (existing) {
      existing.push(schedule);
    } else {
      schedulesByShop.set(schedule.shop, [schedule]);
    }
  }

  // Preload ShopSettings notificationEmail per shop
  const shopDomains = Array.from(schedulesByShop.keys());
  const shopSettingsRows = await prisma.shopSettings.findMany({
    where: { shop: { in: shopDomains } },
    select: { shop: true, notificationEmail: true },
  });
  const emailByShop = new Map<string, string | null>();
  for (const row of shopSettingsRows) {
    emailByShop.set(row.shop, row.notificationEmail);
  }

  let processed = 0;
  let succeeded = 0;
  let overdueHolds = 0;
  let failed = 0;

  for (const [shop, schedules] of schedulesByShop.entries()) {
    const shopNotificationEmail = emailByShop.get(shop) ?? null;

    let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
    try {
      const context = await unauthenticated.admin(shop);
      admin = context.admin;
    } catch (authError) {
      const errorMessage =
        authError instanceof Error
          ? authError.message
          : "Unable to create offline Shopify Admin API client.";
      console.error(
        `[CadenceB2B Cron] Failed to authenticate offline session for ${shop}:`,
        authError,
      );

      for (const schedule of schedules) {
        processed += 1;
        failed += 1;
        await sendExecutionFailedEmail({
          shop,
          toEmail: shopNotificationEmail,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          companyName: schedule.companyName,
          companyLocationName: schedule.companyLocationName,
          errorMessage: `Offline Shopify session error: ${errorMessage}`,
        });
      }
      continue;
    }

    for (const schedule of schedules) {
      try {
        const result = await executeSchedule(admin, schedule.id, false);
        processed += 1;

        if (result.status === "SUCCESS") {
          succeeded += 1;
          await sendOrderExecutedEmail({
            shop,
            toEmail: shopNotificationEmail,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            companyName: schedule.companyName,
            companyLocationName: schedule.companyLocationName,
            executionMode: schedule.executionMode,
            draftOrderId: result.draftOrderId,
            draftOrderName: result.draftOrderName,
            orderId: result.orderId,
            orderName: result.orderName,
          });
        } else if (result.status === "SKIPPED_OVERDUE") {
          overdueHolds += 1;
          await sendOverdueHoldEmail({
            shop,
            toEmail: shopNotificationEmail,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            companyName: schedule.companyName,
            companyLocationName: schedule.companyLocationName,
            overdueOrderNames: result.overdueOrderNames ?? [],
          });
        } else if (result.status === "FAILED") {
          failed += 1;
          await sendExecutionFailedEmail({
            shop,
            toEmail: shopNotificationEmail,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            companyName: schedule.companyName,
            companyLocationName: schedule.companyLocationName,
            errorMessage: result.message,
          });
        }
      } catch (error) {
        processed += 1;
        failed += 1;
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unexpected error while executing recurring schedule.";
        console.error(
          `[CadenceB2B Cron] Error executing schedule ${schedule.id} (${shop}):`,
          error,
        );
        await sendExecutionFailedEmail({
          shop,
          toEmail: shopNotificationEmail,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          companyName: schedule.companyName,
          companyLocationName: schedule.companyLocationName,
          errorMessage,
        });
      }
    }
  }

  return Response.json({
    processed,
    succeeded,
    overdueHolds,
    failed,
    durationMs: Date.now() - startedAt,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return handleRunDueSchedules(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleRunDueSchedules(request);
};
