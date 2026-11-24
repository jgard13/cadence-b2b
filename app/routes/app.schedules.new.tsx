import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ExecutionMode, Frequency, ScheduleStatus } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  buildManagedPricingUrl,
  getActivePlan,
  getB2BCompanies,
  type B2BCompany,
} from "../services/shopifyB2B.server";
import {
  ScheduleForm,
  type ScheduleFormErrors,
  type ScheduleLineItemFormValue,
} from "../components/ScheduleForm";

function getTomorrowDateInput(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function parseDateInputToUtc(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const date = new Date(`${dateStr}T09:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const VALID_FREQUENCIES = new Set<string>(Object.values(Frequency));
const VALID_MODES = new Set<string>(Object.values(ExecutionMode));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [companiesResult, planInfo, activeSchedulesCount] = await Promise.all([
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

  const appHandle = process.env.SHOPIFY_APP_HANDLE?.trim() || "cadenceb2b";
  const storeHandle = session.shop.replace(/\.myshopify\.com$/i, "");
  const pricingUrl = buildManagedPricingUrl(session.shop, appHandle);
  const canSetActive =
    planInfo.maxActiveSchedules === null ||
    activeSchedulesCount < planInfo.maxActiveSchedules;

  return {
    appHandle,
    storeHandle,
    companies: companiesResult.companies,
    companiesLoadError: companiesResult.error,
    defaultNextRunDate: getTomorrowDateInput(),
    planContext: {
      planName: planInfo.planName,
      activeSchedulesCount,
      maxActiveSchedules: planInfo.maxActiveSchedules,
      appHandle,
      storeHandle,
      pricingUrl,
      canSetActive,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

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
  const rawFrequency = String(formData.get("frequency") || Frequency.MONTHLY);
  const rawIntervalDays = String(formData.get("intervalDays") || "").trim();
  const rawExecutionMode = String(
    formData.get("executionMode") || ExecutionMode.DRAFT_ONLY,
  );
  const nextRunDateStr = String(formData.get("nextRunDate") || "").trim();
  const pauseOnOverdue = formData.get("pauseOnOverdue") === "true";
  const poNumberPrefix =
    String(formData.get("poNumberPrefix") || "").trim() || null;
  const note = String(formData.get("note") || "").trim() || null;
  const requestedStatus =
    String(formData.get("status") || ScheduleStatus.ACTIVE) ===
    ScheduleStatus.PAUSED
      ? ScheduleStatus.PAUSED
      : ScheduleStatus.ACTIVE;

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
    : Frequency.MONTHLY;
  const executionMode = VALID_MODES.has(rawExecutionMode)
    ? (rawExecutionMode as ExecutionMode)
    : ExecutionMode.DRAFT_ONLY;

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
    return { errors };
  }

  // Enforce plan limits for ACTIVE schedules
  if (requestedStatus === ScheduleStatus.ACTIVE) {
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
        errors: {
          form: "Unable to verify your subscription plan with Shopify right now. Please try again in a moment.",
        } satisfies ScheduleFormErrors,
      };
    }

    if (
      planInfo.maxActiveSchedules !== null &&
      activeCount >= planInfo.maxActiveSchedules
    ) {
      return {
        errors: {
          form: `Your ${planInfo.planName} plan allows up to ${planInfo.maxActiveSchedules} active recurring ${planInfo.maxActiveSchedules === 1 ? "schedule" : "schedules"}. Upgrade via Shopify Managed Pricing or save this schedule as Paused.`,
        } satisfies ScheduleFormErrors,
      };
    }
  }

  await prisma.recurringSchedule.create({
    data: {
      shop: session.shop,
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
      status: requestedStatus,
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
  });

  return redirect("/app");
};

export default function NewSchedulePage() {
  const { companies, companiesLoadError, defaultNextRunDate, planContext } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Create recurring schedule" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Schedules
      </s-link>

      <ScheduleForm
        mode="create"
        companies={companies}
        companiesLoadError={companiesLoadError}
        planContext={planContext}
        serverErrors={actionData?.errors}
        isSubmitting={isSubmitting}
        initialValues={{
          name: "",
          companyId: "",
          companyName: "",
          companyLocationId: "",
          companyLocationName: "",
          companyContactId: "",
          frequency: "MONTHLY",
          intervalDays: "30",
          executionMode: "DRAFT_ONLY",
          nextRunDate: defaultNextRunDate,
          pauseOnOverdue: true,
          poNumberPrefix: "",
          note: "",
          status: planContext.canSetActive ? "ACTIVE" : "PAUSED",
          lineItems: [],
        }}
        onSubmitValues={(payload) => {
          const formData = new FormData();
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
          submit(formData, { method: "POST" });
        }}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
