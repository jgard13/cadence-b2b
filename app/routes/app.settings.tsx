import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { sendTestEmail } from "../services/notifications.server";

const DEFAULT_TIMEZONE = "America/New_York";

const COMMON_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern Time (America/New_York)" },
  { value: "America/Chicago", label: "Central Time (America/Chicago)" },
  { value: "America/Denver", label: "Mountain Time (America/Denver)" },
  { value: "America/Phoenix", label: "Arizona (America/Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific Time (America/Los_Angeles)" },
  { value: "America/Anchorage", label: "Alaska Time (America/Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii Time (Pacific/Honolulu)" },
  { value: "America/Toronto", label: "Toronto (America/Toronto)" },
  { value: "America/Vancouver", label: "Vancouver (America/Vancouver)" },
  { value: "America/Mexico_City", label: "Mexico City (America/Mexico_City)" },
  { value: "America/Sao_Paulo", label: "São Paulo (America/Sao_Paulo)" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "London (Europe/London)" },
  { value: "Europe/Paris", label: "Paris (Europe/Paris)" },
  { value: "Europe/Berlin", label: "Berlin (Europe/Berlin)" },
  { value: "Europe/Madrid", label: "Madrid (Europe/Madrid)" },
  { value: "Asia/Dubai", label: "Dubai (Asia/Dubai)" },
  { value: "Asia/Singapore", label: "Singapore (Asia/Singapore)" },
  { value: "Asia/Tokyo", label: "Tokyo (Asia/Tokyo)" },
  { value: "Australia/Sydney", label: "Sydney (Australia/Sydney)" },
  { value: "Pacific/Auckland", label: "Auckland (Pacific/Auckland)" },
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidTimezone(tz: string): boolean {
  if (!tz) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });

  return {
    shop: session.shop,
    notificationEmail: settings?.notificationEmail ?? "",
    defaultTimezone: settings?.defaultTimezone ?? DEFAULT_TIMEZONE,
    resendConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
    fromEmail:
      process.env.RESEND_FROM_EMAIL?.trim() ||
      "CadenceB2B <onboarding@resend.dev>",
  };
};

interface SettingsActionResponse {
  ok: boolean;
  intent: string;
  message: string;
  tone: "success" | "warning" | "critical";
  fieldErrors?: {
    notificationEmail?: string;
    defaultTimezone?: string;
  };
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SettingsActionResponse> => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const rawEmail = String(formData.get("notificationEmail") || "").trim();
  const rawTimezone = String(
    formData.get("defaultTimezone") || DEFAULT_TIMEZONE,
  ).trim();

  if (intent === "save") {
    const fieldErrors: SettingsActionResponse["fieldErrors"] = {};

    if (rawEmail.length > 0 && !EMAIL_REGEX.test(rawEmail)) {
      fieldErrors.notificationEmail = "Enter a valid email address.";
    }

    if (!isValidTimezone(rawTimezone)) {
      fieldErrors.defaultTimezone = "Select a valid timezone.";
    }

    if (Object.keys(fieldErrors).length > 0) {
      return {
        ok: false,
        intent,
        message: "Please correct the highlighted fields.",
        tone: "critical",
        fieldErrors,
      };
    }

    await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      update: {
        notificationEmail: rawEmail.length > 0 ? rawEmail : null,
        defaultTimezone: rawTimezone,
      },
      create: {
        shop: session.shop,
        notificationEmail: rawEmail.length > 0 ? rawEmail : null,
        defaultTimezone: rawTimezone,
      },
    });

    return {
      ok: true,
      intent,
      message: "Notification settings saved.",
      tone: "success",
    };
  }

  if (intent === "send_test") {
    if (rawEmail.length > 0 && !EMAIL_REGEX.test(rawEmail)) {
      return {
        ok: false,
        intent,
        message: "Enter a valid email address before sending a test email.",
        tone: "critical",
        fieldErrors: {
          notificationEmail: "Enter a valid email address.",
        },
      };
    }

    const existingSettings = await prisma.shopSettings.findUnique({
      where: { shop: session.shop },
    });

    const targetEmail =
      rawEmail.length > 0
        ? rawEmail
        : (existingSettings?.notificationEmail?.trim() ?? "");

    if (!targetEmail) {
      return {
        ok: false,
        intent,
        message:
          "Configure a notification email address first to send a test email.",
        tone: "warning",
        fieldErrors: {
          notificationEmail: "Enter a notification email address.",
        },
      };
    }

    const timezoneToReport = isValidTimezone(rawTimezone)
      ? rawTimezone
      : (existingSettings?.defaultTimezone ?? DEFAULT_TIMEZONE);

    const result = await sendTestEmail({
      shop: session.shop,
      toEmail: targetEmail,
      defaultTimezone: timezoneToReport,
    });

    if (result.sent) {
      return {
        ok: true,
        intent,
        message: `Test email sent to ${targetEmail}.`,
        tone: "success",
      };
    }

    return {
      ok: false,
      intent,
      message: result.skipped
        ? `Test email skipped: ${result.reason || "Email delivery is not configured."}`
        : `Could not send test email: ${result.reason || "Resend returned an error."}`,
      tone: result.skipped ? "warning" : "critical",
    };
  }

  return {
    ok: false,
    intent,
    message: "Unsupported action.",
    tone: "critical",
  };
};

export default function SettingsPage() {
  const {
    shop,
    notificationEmail: initialEmail,
    defaultTimezone: initialTimezone,
    resendConfigured,
    fromEmail,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<SettingsActionResponse>();
  const shopify = useAppBridge();

  const [notificationEmail, setNotificationEmail] = useState(initialEmail);
  const [defaultTimezone, setDefaultTimezone] = useState(initialTimezone);
  const [clientEmailError, setClientEmailError] = useState<string | undefined>(
    undefined,
  );

  useEffect(() => {
    setNotificationEmail(initialEmail);
    setDefaultTimezone(initialTimezone);
  }, [initialEmail, initialTimezone]);

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, {
        isError: !fetcher.data.ok,
      });
    }
  }, [fetcher.data, shopify]);

  const timezoneOptions = useMemo(() => {
    const exists = COMMON_TIMEZONES.some((tz) => tz.value === defaultTimezone);
    if (exists || !defaultTimezone) {
      return COMMON_TIMEZONES;
    }
    return [
      { value: defaultTimezone, label: defaultTimezone },
      ...COMMON_TIMEZONES,
    ];
  }, [defaultTimezone]);

  const isSubmitting = fetcher.state !== "idle";
  const pendingIntent = isSubmitting
    ? String(fetcher.formData?.get("intent") || "")
    : "";

  const emailError =
    clientEmailError ?? fetcher.data?.fieldErrors?.notificationEmail;
  const timezoneError = fetcher.data?.fieldErrors?.defaultTimezone;

  const handleSave = () => {
    const trimmed = notificationEmail.trim();
    if (trimmed.length > 0 && !EMAIL_REGEX.test(trimmed)) {
      setClientEmailError("Enter a valid email address.");
      return;
    }
    setClientEmailError(undefined);
    fetcher.submit(
      {
        intent: "save",
        notificationEmail: trimmed,
        defaultTimezone,
      },
      { method: "POST" },
    );
  };

  const handleSendTest = () => {
    const trimmed = notificationEmail.trim();
    if (!trimmed) {
      setClientEmailError("Enter a notification email address.");
      return;
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      setClientEmailError("Enter a valid email address.");
      return;
    }
    setClientEmailError(undefined);
    fetcher.submit(
      {
        intent: "send_test",
        notificationEmail: trimmed,
        defaultTimezone,
      },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Settings" inlineSize="base">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={pendingIntent === "save"}
        disabled={isSubmitting}
        onClick={handleSave}
      >
        Save settings
      </s-button>

      <s-stack direction="block" gap="base">
        {!resendConfigured && (
          <s-banner
            tone="warning"
            heading="Resend API key is not configured"
          >
            <s-paragraph>
              The server environment does not have <code>RESEND_API_KEY</code>{" "}
              set. You can still save your notification email below, and
              recurring orders will continue executing normally, but alert
              emails will be skipped until Resend is configured.
            </s-paragraph>
          </s-banner>
        )}

        {fetcher.data && (
          <s-banner
            tone={fetcher.data.tone}
            heading={
              fetcher.data.ok
                ? fetcher.data.intent === "send_test"
                  ? "Test email delivered"
                  : "Settings updated"
                : fetcher.data.tone === "warning"
                  ? "Action needed"
                  : "Unable to complete request"
            }
          >
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        )}

        <s-section heading="Notification Preferences">
          <s-stack direction="block" gap="base">
            <s-email-field
              label="Notification email"
              name="notificationEmail"
              placeholder="ops@yourcompany.com"
              value={notificationEmail}
              error={emailError}
              details="Merchant email address that receives recurring order confirmations, Overdue Hold alerts, and failure notices."
              onInput={(e) => {
                setNotificationEmail(e.currentTarget.value);
                setClientEmailError(undefined);
              }}
            />

            <s-select
              label="Default timezone"
              name="defaultTimezone"
              value={defaultTimezone}
              error={timezoneError}
              details={`Store default timezone for ${shop}.`}
              onChange={(e) => setDefaultTimezone(e.currentTarget.value)}
            >
              {timezoneOptions.map((tz) => (
                <s-option key={tz.value} value={tz.value}>
                  {tz.label}
                </s-option>
              ))}
            </s-select>

            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                loading={pendingIntent === "save"}
                disabled={isSubmitting}
                onClick={handleSave}
              >
                Save settings
              </s-button>
              <s-button
                variant="secondary"
                loading={pendingIntent === "send_test"}
                disabled={isSubmitting}
                onClick={handleSendTest}
              >
                Send test email
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Automated Email Alerts">
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              When automated schedules run, CadenceB2B sends notifications from{" "}
              <s-text type="strong">{fromEmail}</s-text> for the following
              events:
            </s-paragraph>
            <s-unordered-list>
              <s-list-item>
                <s-text type="strong">Order Executed:</s-text> Confirms the
                schedule, B2B Company, Company Location, created Draft Order or
                Order number, and includes a direct link to Shopify Admin.
              </s-list-item>
              <s-list-item>
                <s-text type="strong">Overdue Hold Alert:</s-text> Urgent alert
                when a schedule is automatically paused in{" "}
                <code>OVERDUE_HOLD</code>, listing the overdue invoice numbers
                detected on that Company Location.
              </s-list-item>
              <s-list-item>
                <s-text type="strong">Execution Failed:</s-text> Reports the
                exact Shopify API or validation error if a scheduled run fails.
              </s-list-item>
            </s-unordered-list>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
