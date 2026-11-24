import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  redirect,
  useFetcher,
  useLoaderData,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  ExecutionMode,
  ExecutionStatus,
  Frequency,
  ScheduleStatus,
} from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  buildManagedPricingUrl,
  getActivePlan,
  getB2BCompanies,
  type B2BCompany,
} from "../services/shopifyB2B.server";
import { executeSchedule } from "../services/scheduleRunner.server";
import {
  ScheduleForm,
  type ScheduleFormErrors,
  type ScheduleLineItemFormValue,
} from "../components/ScheduleForm";

function parseDateInputToUtc(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const date = new Date(`${dateStr}T09:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractNumericGid(gid: string | null): string | null {
  if (!gid) {
    return null;
  }
  const parts = gid.split("/");
  const last = parts[parts.length - 1];
  return last && /^\d+$/.test(last) ? last : null;
}

const VALID_FREQUENCIES = new Set<string>(Object.values(Frequency));
const VALID_MODES = new Set<string>(Object.values(ExecutionMode));

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const scheduleId = params.id;

  if (!scheduleId) {
    throw new Response("Missing schedule ID", { status: 400 });
  }

  const [schedule, companiesResult, planInfo, activeSchedulesCount] =
    await Promise.all([
      prisma.recurringSchedule.findFirst({
        where: {
          id: scheduleId,
          shop: session.shop,
        },
        include: {
          lineItems: true,
          logs: {
            orderBy: { executedAt: "desc" },
            take: 25,
          },
        },
      }),
      getB2BCompanies(admin)
        .then((companies) => ({ companies, error: null as string | null }))
        .catch((err: unknown) => ({
          companies: [] as B2BCompany[],
          error:
            err instanceof Error
              ? err.message
              : "Could not load B2B Companies from Shopify.",
        })),
      getActivePlan(admin, { requestUrl: request.url }),
      prisma.recurringSchedule.count({
        where: {
          shop: session.shop,
          status: ScheduleStatus.ACTIVE,
        },
      }),
    ]);

  if (!schedule) {
    throw new Response("Schedule not found", { status: 404 });
  }

  const pricingUrl = buildManagedPricingUrl(session.shop, planInfo.appHandle);
  const isAlreadyActive = schedule.status === ScheduleStatus.ACTIVE;
  const canSetActive =
    isAlreadyActive ||
    planInfo.maxActiveSchedules === null ||
    activeSchedulesCount < planInfo.maxActiveSchedules;

  const shopHandle = session.shop.replace(/\.myshopify\.com$/i, "");

  return {
    shopHandle,
    schedule: {
      id: schedule.id,
      name: schedule.name,
      companyId: schedule.companyId,
      companyName: schedule.companyName,
      companyLocationId: schedule.companyLocationId,
      companyLocationName: schedule.companyLocationName,
      companyContactId: schedule.companyContactId ?? "",
      frequency: schedule.frequency,
      intervalDays: schedule.intervalDays ? String(schedule.intervalDays) : "30",
      executionMode: schedule.executionMode,
      nextRunDate: schedule.nextRunAt.toISOString().slice(0, 10),
      lastRunAt: schedule.lastRunAt ? schedule.lastRunAt.toISOString() : null,
      pauseOnOverdue: schedule.pauseOnOverdue,
      poNumberPrefix: schedule.poNumberPrefix ?? "",
      note: schedule.note ?? "",
      status: schedule.status,
      lineItems: schedule.lineItems.map((item) => ({
        variantId: item.variantId,
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
      })),
    },
    logs: schedule.logs.map((log) => ({
      id: log.id,
      status: log.status,
      shopifyDraftOrderId: log.shopifyDraftOrderId,
      shopifyOrderId: log.shopifyOrderId,
      errorMessage: log.errorMessage,
      executedAt: log.executedAt.toISOString(),
    })),
    companies: companiesResult.companies,
    companiesLoadError: companiesResult.error,
    planContext: {
      planName: planInfo.planName,
      activeSchedulesCount,
      maxActiveSchedules: planInfo.maxActiveSchedules,
      pricingUrl,
      canSetActive,
    },
  };
};

interface ScheduleDetailActionResult {
  ok: boolean;
  intent: string;
  message?: string;
  tone?: "success" | "warning" | "critical";
  errors?: ScheduleFormErrors;
}

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<Response | ScheduleDetailActionResult> => {
  const { admin, session } = await authenticate.admin(request);
  const scheduleId = params.id;

  if (!scheduleId) {
    return {
      ok: false,
      intent: "unknown",
      message: "Missing schedule ID.",
      tone: "critical",
    };
  }

  const existing = await prisma.recurringSchedule.findFirst({
    where: {
      id: scheduleId,
      shop: session.shop,
    },
  });

  if (!existing) {
    throw new Response("Schedule not found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "update");

  if (intent === "delete") {
    await prisma.recurringSchedule.delete({
      where: { id: existing.id },
    });
    return redirect("/app");
  }

  if (intent === "run_now") {
    const result = await executeSchedule(admin, existing.id, true);
    return {
      ok: result.ok,
      intent,
      message: result.message,
      tone:
        result.status === "SUCCESS"
          ? "success"
          : result.status === "SKIPPED_OVERDUE"
            ? "warning"
            : "critical",
    };
  }

  // Update schedule
  const name = String(formData.get("name") || "").trim();
  const companyId = String(formData.get("companyId") || "").trim();
  const companyName = String(formData.get("companyName") || "").trim();
  const companyLocationId = String(
    formData.get("companyLocationId") || "",
  ).trim();
  const companyLocationName = String(
    formData.get("companyLocationName") || "",
  ).trim();
  const companyContactId =
    String(formData.get("companyContactId") || "").trim() || null;
  const rawFrequency = String(formData.get("frequency") || existing.frequency);
  const rawIntervalDays = String(formData.get("intervalDays") || "").trim();
  const rawExecutionMode = String(
    formData.get("executionMode") || existing.executionMode,
  );
  const nextRunDateStr = String(formData.get("nextRunDate") || "").trim();
  const pauseOnOverdue = formData.get("pauseOnOverdue") === "true";
  const poNumberPrefix =
    String(formData.get("poNumberPrefix") || "").trim() || null;
  const note = String(formData.get("note") || "").trim() || null;
  const rawStatus = String(formData.get("status") || existing.status);

  let targetStatus: ScheduleStatus = existing.status;
  if (rawStatus === ScheduleStatus.ACTIVE) {
    targetStatus = ScheduleStatus.ACTIVE;
  } else if (rawStatus === ScheduleStatus.PAUSED) {
    targetStatus = ScheduleStatus.PAUSED;
  }

  const errors: ScheduleFormErrors = {};

  if (!name) {
    errors.name = "Enter a schedule name.";
  }
  if (!companyId) {
    errors.companyId = "Select a B2B Company.";
  }
  if (!companyLocationId) {
    errors.companyLocationId = "Select a Company Location.";
  }

  const frequency = VALID_FREQUENCIES.has(rawFrequency)
    ? (rawFrequency as Frequency)
    : existing.frequency;
  const executionMode = VALID_MODES.has(rawExecutionMode)
    ? (rawExecutionMode as ExecutionMode)
    : existing.executionMode;

  let intervalDays: number | null = null;
  if (frequency === Frequency.CUSTOM_DAYS) {
    const parsed = Number.parseInt(rawIntervalDays, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      errors.intervalDays = "Enter a valid interval of at least 1 day.";
    } else {
      intervalDays = parsed;
    }
  }

  const nextRunAt = parseDateInputToUtc(nextRunDateStr);
  if (!nextRunAt) {
    errors.nextRunDate = "Choose a valid next run date (YYYY-MM-DD).";
  }

  let parsedLineItems: ScheduleLineItemFormValue[] = [];
  try {
    const rawItems = JSON.parse(String(formData.get("lineItems") || "[]"));
    if (Array.isArray(rawItems)) {
      parsedLineItems = rawItems
        .filter(
          (item): item is ScheduleLineItemFormValue =>
            typeof item === "object" &&
            item !== null &&
            typeof item.variantId === "string" &&
            item.variantId.trim().length > 0 &&
            typeof item.productTitle === "string",
        )
        .map((item) => ({
          variantId: item.variantId.trim(),
          productTitle: item.productTitle.trim() || "Product",
          variantTitle:
            typeof item.variantTitle === "string" &&
            item.variantTitle.trim().length > 0
              ? item.variantTitle.trim()
              : null,
          quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        }));
    }
  } catch {
    errors.lineItems = "Invalid line items payload.";
  }

  if (parsedLineItems.length === 0) {
    errors.lineItems = "Add at least one product variant.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, intent: "update", errors };
  }

  // Enforce plan limits when transitioning a non-active schedule to ACTIVE
  if (
    targetStatus === ScheduleStatus.ACTIVE &&
    existing.status !== ScheduleStatus.ACTIVE
  ) {
    let planInfo: Awaited<ReturnType<typeof getActivePlan>>;
    let activeCount: number;
    try {
      [planInfo, activeCount] = await Promise.all([
        getActivePlan(admin, { requestUrl: request.url }),
        prisma.recurringSchedule.count({
          where: {
            shop: session.shop,
            status: ScheduleStatus.ACTIVE,
          },
        }),
      ]);
    } catch (error) {
      console.error("[Billing] Failed to verify active subscription:", error);
      return {
        ok: false,
        intent: "update",
        errors: {
          form: "Unable to verify your subscription plan with Shopify right now. Please try again in a moment.",
        },
      };
    }

    if (
      planInfo.maxActiveSchedules !== null &&
      activeCount >= planInfo.maxActiveSchedules
    ) {
      return {
        ok: false,
        intent: "update",
        errors: {
          form: `Your ${planInfo.planName} plan allows up to ${planInfo.maxActiveSchedules} active recurring ${planInfo.maxActiveSchedules === 1 ? "schedule" : "schedules"}. Upgrade via Shopify Managed Pricing or pause another schedule first.`,
        },
      };
    }
  }

  await prisma.$transaction([
    prisma.scheduleLineItem.deleteMany({
      where: { scheduleId: existing.id },
    }),
    prisma.recurringSchedule.update({
      where: { id: existing.id },
      data: {
        name,
        companyId,
        companyName: companyName || companyId,
        companyLocationId,
        companyLocationName: companyLocationName || companyLocationId,
        companyContactId,
        frequency,
        intervalDays,
        executionMode,
        pauseOnOverdue,
        status: targetStatus,
        nextRunAt: nextRunAt!,
        poNumberPrefix,
        note,
        lineItems: {
          create: parsedLineItems.map((item) => ({
            variantId: item.variantId,
            productTitle: item.productTitle,
            variantTitle: item.variantTitle,
            quantity: item.quantity,
          })),
        },
      },
    }),
  ]);

  return {
    ok: true,
    intent: "update",
    message: "Schedule updated.",
    tone: "success",
  };
};

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function getLogBadgeProps(status: ExecutionStatus): {
  label: string;
  tone: "success" | "warning" | "critical";
} {
  switch (status) {
    case ExecutionStatus.SUCCESS:
      return { label: "Success", tone: "success" };
    case ExecutionStatus.SKIPPED_OVERDUE:
      return { label: "Skipped (Overdue)", tone: "warning" };
    case ExecutionStatus.FAILED:
      return { label: "Failed", tone: "critical" };
    default:
      return { label: status, tone: "warning" };
  }
}

export default function EditSchedulePage() {
  const {
    shopHandle,
    schedule,
    logs,
    companies,
    companiesLoadError,
    planContext,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ScheduleDetailActionResult>();
  const shopify = useAppBridge();

  const isBusy = fetcher.state !== "idle";
  const pendingIntent = isBusy
    ? String(fetcher.formData?.get("intent") || "")
    : "";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, {
        isError: !fetcher.data.ok,
      });
    }
  }, [fetcher.data, shopify]);

  const handleRunNow = () => {
    fetcher.submit({ intent: "run_now" }, { method: "POST" });
  };

  const handleDelete = () => {
    fetcher.submit({ intent: "delete" }, { method: "POST" });
  };

  return (
    <s-page heading={schedule.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Schedules
      </s-link>

      <s-button
        slot="secondary-actions"
        variant="secondary"
        loading={pendingIntent === "run_now"}
        disabled={isBusy}
        onClick={handleRunNow}
      >
        Run Now (Test)
      </s-button>
      <s-button
        slot="secondary-actions"
        variant="secondary"
        tone="critical"
        loading={pendingIntent === "delete"}
        disabled={isBusy}
        onClick={handleDelete}
      >
        Delete
      </s-button>

      <s-stack direction="block" gap="large">
        {schedule.status === ScheduleStatus.OVERDUE_HOLD && (
          <s-banner tone="critical" heading="Schedule is on Overdue Hold">
            <s-paragraph>
              An overdue invoice was detected on {schedule.companyLocationName}.
              Once overdue invoices are settled in Shopify Admin, set the
              schedule status back to Active and save to resume recurring runs.
            </s-paragraph>
          </s-banner>
        )}

        {fetcher.data?.intent === "run_now" && fetcher.data.message && (
          <s-banner
            tone={
              fetcher.data.tone === "success"
                ? "success"
                : fetcher.data.tone === "warning"
                  ? "warning"
                  : "critical"
            }
            heading={
              fetcher.data.ok
                ? "Manual test run succeeded"
                : fetcher.data.tone === "warning"
                  ? "Manual test run skipped (Overdue Hold)"
                  : "Manual test run failed"
            }
          >
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        )}

        <ScheduleForm
          mode="edit"
          companies={companies}
          companiesLoadError={companiesLoadError}
          planContext={planContext}
          serverErrors={fetcher.data?.errors}
          isSubmitting={pendingIntent === "update"}
          initialValues={{
            name: schedule.name,
            companyId: schedule.companyId,
            companyName: schedule.companyName,
            companyLocationId: schedule.companyLocationId,
            companyLocationName: schedule.companyLocationName,
            companyContactId: schedule.companyContactId,
            frequency: schedule.frequency,
            intervalDays: schedule.intervalDays,
            executionMode: schedule.executionMode,
            nextRunDate: schedule.nextRunDate,
            pauseOnOverdue: schedule.pauseOnOverdue,
            poNumberPrefix: schedule.poNumberPrefix,
            note: schedule.note,
            status: schedule.status,
            lineItems: schedule.lineItems,
          }}
          onSubmitValues={(payload) => {
            const formData = new FormData();
            formData.set("intent", "update");
            formData.set("name", payload.name);
            formData.set("companyId", payload.companyId);
            formData.set("companyName", payload.companyName);
            formData.set("companyLocationId", payload.companyLocationId);
            formData.set("companyLocationName", payload.companyLocationName);
            formData.set("companyContactId", payload.companyContactId);
            formData.set("frequency", payload.frequency);
            formData.set("intervalDays", payload.intervalDays);
            formData.set("executionMode", payload.executionMode);
            formData.set("nextRunDate", payload.nextRunDate);
            formData.set("pauseOnOverdue", String(payload.pauseOnOverdue));
            formData.set("poNumberPrefix", payload.poNumberPrefix);
            formData.set("note", payload.note);
            formData.set("status", payload.status);
            formData.set("lineItems", JSON.stringify(payload.lineItems));
            fetcher.submit(formData, { method: "POST" });
          }}
        />

        <s-section
          heading="Recent Execution Logs"
          padding={logs.length > 0 ? "none" : "base"}
        >
          {logs.length === 0 ? (
            <s-paragraph color="subdued">
              No executions recorded yet. Click &quot;Run Now (Test)&quot; above
              to test this schedule against Shopify B2B.
            </s-paragraph>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Executed At</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Draft Order</s-table-header>
                <s-table-header>Order</s-table-header>
                <s-table-header>Details</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {logs.map((log) => {
                  const badge = getLogBadgeProps(log.status);
                  const draftNumericId = extractNumericGid(
                    log.shopifyDraftOrderId,
                  );
                  const orderNumericId = extractNumericGid(log.shopifyOrderId);

                  return (
                    <s-table-row key={log.id}>
                      <s-table-cell>
                        <s-text>{formatDateTime(log.executedAt)}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={badge.tone}>{badge.label}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {draftNumericId ? (
                          <s-link
                            href={`https://admin.shopify.com/store/${shopHandle}/draft_orders/${draftNumericId}`}
                            target="_blank"
                          >
                            #{draftNumericId}
                          </s-link>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {orderNumericId ? (
                          <s-link
                            href={`https://admin.shopify.com/store/${shopHandle}/orders/${orderNumericId}`}
                            target="_blank"
                          >
                            #{orderNumericId}
                          </s-link>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-text
                          tone={
                            log.status === ExecutionStatus.FAILED
                              ? "critical"
                              : "auto"
                          }
                          color={log.errorMessage ? "base" : "subdued"}
                        >
                          {log.errorMessage || "—"}
                        </s-text>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
