import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
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
  hasAnyB2BCompanies,
} from "../services/shopifyB2B.server";
import { executeSchedule } from "../services/scheduleRunner.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [schedules, ordersExecutedLast30Days, planInfo, b2bStatus] =
    await Promise.all([
      prisma.recurringSchedule.findMany({
        where: { shop: session.shop },
        orderBy: [{ status: "asc" }, { nextRunAt: "asc" }],
        include: {
          _count: {
            select: { lineItems: true },
          },
        },
      }),
      prisma.executionLog.count({
        where: {
          shop: session.shop,
          status: ExecutionStatus.SUCCESS,
          executedAt: { gte: thirtyDaysAgo },
        },
      }),
      getActivePlan(admin, { requestUrl: request.url }),
      hasAnyB2BCompanies(admin)
        .then((hasCompanies) => ({ hasCompanies, error: null as string | null }))
        .catch((err: unknown) => ({
          hasCompanies: false,
          error:
            err instanceof Error
              ? err.message
              : "Unable to query Shopify B2B Companies.",
        })),
    ]);

  const activeSchedulesCount = schedules.filter(
    (s) => s.status === ScheduleStatus.ACTIVE,
  ).length;
  const overdueHoldsCount = schedules.filter(
    (s) => s.status === ScheduleStatus.OVERDUE_HOLD,
  ).length;

  const pricingUrl = buildManagedPricingUrl(session.shop, planInfo.appHandle);
  const shopHandle = session.shop.replace(/\.myshopify\.com$/i, "");
  const companiesAdminUrl = `https://admin.shopify.com/store/${shopHandle}/companies`;

  return {
    schedules: schedules.map((s) => ({
      id: s.id,
      name: s.name,
      companyName: s.companyName,
      companyLocationName: s.companyLocationName,
      frequency: s.frequency,
      intervalDays: s.intervalDays,
      nextRunAt: s.nextRunAt.toISOString(),
      executionMode: s.executionMode,
      status: s.status,
      lineItemCount: s._count.lineItems,
    })),
    kpis: {
      activeSchedulesCount,
      overdueHoldsCount,
      ordersExecutedLast30Days,
    },
    plan: {
      tier: planInfo.tier,
      planName: planInfo.planName,
      maxActiveSchedules: planInfo.maxActiveSchedules,
      pricingUrl,
    },
    hasB2BCompanies: b2bStatus.hasCompanies,
    b2bCheckError: b2bStatus.error,
    companiesAdminUrl,
  };
};

interface ActionResponse {
  ok: boolean;
  intent: string;
  message: string;
  tone: "success" | "warning" | "critical";
  pricingUrl?: string;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const scheduleId = String(formData.get("scheduleId") || "");

  if (!scheduleId) {
    return {
      ok: false,
      intent,
      message: "Missing schedule ID.",
      tone: "critical",
    };
  }

  const schedule = await prisma.recurringSchedule.findFirst({
    where: {
      id: scheduleId,
      shop: session.shop,
    },
  });

  if (!schedule) {
    return {
      ok: false,
      intent,
      message: "Schedule not found for this store.",
      tone: "critical",
    };
  }

  if (intent === "toggle_status") {
    const targetStatus =
      schedule.status === ScheduleStatus.ACTIVE
        ? ScheduleStatus.PAUSED
        : ScheduleStatus.ACTIVE;

    if (targetStatus === ScheduleStatus.ACTIVE) {
      let planInfo: Awaited<ReturnType<typeof getActivePlan>>;
      let currentActiveCount: number;
      try {
        [planInfo, currentActiveCount] = await Promise.all([
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
          intent,
          message:
            "Unable to verify your subscription plan with Shopify right now. Please try again in a moment.",
          tone: "critical",
        };
      }

      if (
        planInfo.maxActiveSchedules !== null &&
        currentActiveCount >= planInfo.maxActiveSchedules
      ) {
        const pricingUrl = buildManagedPricingUrl(
          session.shop,
          planInfo.appHandle,
        );
        return {
          ok: false,
          intent,
          message: `Your ${planInfo.planName} plan allows up to ${planInfo.maxActiveSchedules} active recurring ${planInfo.maxActiveSchedules === 1 ? "schedule" : "schedules"}. Upgrade your plan or pause another schedule first.`,
          tone: "warning",
          pricingUrl,
        };
      }
    }

    await prisma.recurringSchedule.update({
      where: { id: schedule.id },
      data: { status: targetStatus },
    });

    return {
      ok: true,
      intent,
      message:
        targetStatus === ScheduleStatus.ACTIVE
          ? `Resumed "${schedule.name}".`
          : `Paused "${schedule.name}".`,
      tone: "success",
    };
  }

  if (intent === "run_now") {
    const result = await executeSchedule(admin, schedule.id, true);
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

  return {
    ok: false,
    intent,
    message: "Unsupported action.",
    tone: "critical",
  };
};

function formatFrequency(
  frequency: Frequency,
  intervalDays: number | null,
): string {
  switch (frequency) {
    case Frequency.WEEKLY:
      return "Weekly";
    case Frequency.BIWEEKLY:
      return "Biweekly";
    case Frequency.MONTHLY:
      return "Monthly";
    case Frequency.CUSTOM_DAYS:
      return `Every ${intervalDays ?? 30} days`;
    default:
      return frequency;
  }
}

function formatExecutionMode(mode: ExecutionMode): string {
  switch (mode) {
    case ExecutionMode.DRAFT_ONLY:
      return "Draft Only";
    case ExecutionMode.SEND_INVOICE:
      return "Send Invoice";
    case ExecutionMode.COMPLETE_NET_TERMS:
      return "Complete (Net Terms)";
    default:
      return mode;
  }
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function getStatusBadgeProps(status: ScheduleStatus): {
  label: string;
  tone: "success" | "neutral" | "critical";
} {
  switch (status) {
    case ScheduleStatus.ACTIVE:
      return { label: "Active", tone: "success" };
    case ScheduleStatus.PAUSED:
      return { label: "Paused", tone: "neutral" };
    case ScheduleStatus.OVERDUE_HOLD:
      return { label: "Overdue Hold", tone: "critical" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export default function DashboardPage() {
  const {
    schedules,
    kpis,
    plan,
    hasB2BCompanies,
    b2bCheckError,
    companiesAdminUrl,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResponse>();
  const shopify = useAppBridge();

  const isSubmitting = fetcher.state !== "idle";
  const pendingScheduleId = isSubmitting
    ? String(fetcher.formData?.get("scheduleId") || "")
    : "";
  const pendingIntent = isSubmitting
    ? String(fetcher.formData?.get("intent") || "")
    : "";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, {
        isError: !fetcher.data.ok,
      });
    }
  }, [fetcher.data, shopify]);

  const isAtPlanLimit =
    plan.maxActiveSchedules !== null &&
    kpis.activeSchedulesCount >= plan.maxActiveSchedules;

  const submitAction = (intent: string, scheduleId: string) => {
    fetcher.submit({ intent, scheduleId }, { method: "POST" });
  };

  return (
    <s-page heading="CadenceB2B" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        href="/app/schedules/new"
      >
        Create schedule
      </s-button>

      <s-stack direction="block" gap="base">
        {!hasB2BCompanies && (
          <s-banner
            tone="warning"
            heading={
              b2bCheckError
                ? "Unable to access Shopify B2B Companies"
                : "No Shopify B2B Companies found"
            }
          >
            <s-paragraph>
              {b2bCheckError
                ? `We could not load B2B Companies from Shopify (${b2bCheckError}). Confirm your store has Shopify B2B enabled and the required scopes granted.`
                : "CadenceB2B automates standing orders for native Shopify B2B Company Locations. Create at least one Company and Location in Shopify Admin before setting up a schedule."}
            </s-paragraph>
            <s-button
              slot="secondary-actions"
              variant="secondary"
              href={companiesAdminUrl}
              target="_blank"
            >
              Manage B2B Companies
            </s-button>
          </s-banner>
        )}

        {isAtPlanLimit && (
          <s-banner
            tone="info"
            heading={`${plan.planName} plan limit reached (${kpis.activeSchedulesCount}/${plan.maxActiveSchedules} active ${plan.maxActiveSchedules === 1 ? "schedule" : "schedules"})`}
          >
            <s-paragraph>
              You have reached the maximum number of active recurring schedules
              for your {plan.planName} plan. Upgrade via Shopify Managed Pricing
              to unlock up to 30 active schedules (Growth) or unlimited
              schedules (Scale).
            </s-paragraph>
            <s-button
              slot="secondary-actions"
              variant="secondary"
              href={plan.pricingUrl}
              target="_top"
            >
              View pricing plans
            </s-button>
          </s-banner>
        )}

        {fetcher.data && !fetcher.data.ok && (
          <s-banner
            tone={fetcher.data.tone === "warning" ? "warning" : "critical"}
            heading={
              fetcher.data.tone === "warning"
                ? "Action paused"
                : "Execution failed"
            }
          >
            <s-paragraph>{fetcher.data.message}</s-paragraph>
            {fetcher.data.pricingUrl && (
              <s-button
                slot="secondary-actions"
                variant="secondary"
                href={fetcher.data.pricingUrl}
                target="_top"
              >
                Upgrade plan
              </s-button>
            )}
          </s-banner>
        )}

        <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
          <s-section heading="Active Schedules">
            <s-stack direction="block" gap="small-200">
              <s-heading>{kpis.activeSchedulesCount}</s-heading>
              <s-text color="subdued">
                {plan.maxActiveSchedules !== null
                  ? `${kpis.activeSchedulesCount} of ${plan.maxActiveSchedules} allowed on ${plan.planName} plan`
                  : `Unlimited on ${plan.planName} plan`}
              </s-text>
            </s-stack>
          </s-section>

          <s-section heading="Overdue Holds">
            <s-stack direction="block" gap="small-200">
              <s-heading>{kpis.overdueHoldsCount}</s-heading>
              <s-text
                tone={kpis.overdueHoldsCount > 0 ? "critical" : "auto"}
                color={kpis.overdueHoldsCount > 0 ? "base" : "subdued"}
              >
                {kpis.overdueHoldsCount > 0
                  ? "Paused automatically for overdue invoices"
                  : "All locations in good standing"}
              </s-text>
            </s-stack>
          </s-section>

          <s-section heading="Orders Executed (Last 30 Days)">
            <s-stack direction="block" gap="small-200">
              <s-heading>{kpis.ordersExecutedLast30Days}</s-heading>
              <s-text color="subdued">
                Successful recurring order runs
              </s-text>
            </s-stack>
          </s-section>
        </s-grid>

        {schedules.length === 0 ? (
          <s-section>
            <s-empty-state heading="No recurring B2B schedules yet">
              <s-text slot="subheading">
                Create your first standing order schedule for a B2B Company
                Location to automate draft orders, invoices, or Net Terms orders
                with automatic Overdue Invoice Hold protection.
              </s-text>
              <s-button
                slot="primary-action"
                variant="primary"
                href="/app/schedules/new"
              >
                Create schedule
              </s-button>
            </s-empty-state>
          </s-section>
        ) : (
          <s-section heading="Recurring Schedules" padding="none">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Company</s-table-header>
                <s-table-header listSlot="secondary">Location</s-table-header>
                <s-table-header>Frequency</s-table-header>
                <s-table-header>Next Run Date</s-table-header>
                <s-table-header>Mode</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {schedules.map((schedule) => {
                  const badge = getStatusBadgeProps(schedule.status);
                  const isRunningThis =
                    pendingScheduleId === schedule.id &&
                    pendingIntent === "run_now";
                  const isTogglingThis =
                    pendingScheduleId === schedule.id &&
                    pendingIntent === "toggle_status";

                  return (
                    <s-table-row key={schedule.id}>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-300">
                          <s-link href={`/app/schedules/${schedule.id}`}>
                            <s-text type="strong">{schedule.companyName}</s-text>
                          </s-link>
                          <s-text color="subdued">
                            {schedule.name} ({schedule.lineItemCount}{" "}
                            {schedule.lineItemCount === 1 ? "item" : "items"})
                          </s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text>{schedule.companyLocationName}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text>
                          {formatFrequency(
                            schedule.frequency,
                            schedule.intervalDays,
                          )}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text>{formatDate(schedule.nextRunAt)}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text>
                          {formatExecutionMode(schedule.executionMode)}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={badge.tone}>{badge.label}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-200">
                          <s-button
                            variant="tertiary"
                            href={`/app/schedules/${schedule.id}`}
                          >
                            Edit
                          </s-button>
                          <s-button
                            variant="secondary"
                            loading={isTogglingThis}
                            disabled={isSubmitting}
                            onClick={() =>
                              submitAction("toggle_status", schedule.id)
                            }
                          >
                            {schedule.status === ScheduleStatus.ACTIVE
                              ? "Pause"
                              : "Resume"}
                          </s-button>
                          <s-button
                            variant="primary"
                            loading={isRunningThis}
                            disabled={isSubmitting}
                            onClick={() => submitAction("run_now", schedule.id)}
                          >
                            Run Now (Test)
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
