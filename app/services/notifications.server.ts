import { Resend } from "resend";
import type { ExecutionMode } from "@prisma/client";
import prisma from "../db.server";

const DEFAULT_FROM_EMAIL = "CadenceB2B <onboarding@resend.dev>";
const DEFAULT_APP_HANDLE = "cadenceb2b";

export interface NotificationResult {
  sent: boolean;
  skipped: boolean;
  id?: string;
  reason?: string;
}

export interface OrderExecutedEmailParams {
  shop: string;
  toEmail?: string | null;
  scheduleId: string;
  scheduleName: string;
  companyName: string;
  companyLocationName: string;
  executionMode: ExecutionMode | string;
  draftOrderId?: string | null;
  draftOrderName?: string | null;
  orderId?: string | null;
  orderName?: string | null;
  executedAt?: Date;
}

export interface OverdueHoldEmailParams {
  shop: string;
  toEmail?: string | null;
  scheduleId: string;
  scheduleName: string;
  companyName: string;
  companyLocationName: string;
  overdueOrderNames: string[];
  checkedAt?: Date;
}

export interface ExecutionFailedEmailParams {
  shop: string;
  toEmail?: string | null;
  scheduleId: string;
  scheduleName: string;
  companyName: string;
  companyLocationName: string;
  errorMessage: string;
  failedAt?: Date;
}

export interface TestEmailParams {
  shop: string;
  toEmail?: string | null;
  defaultTimezone?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getShopHandle(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, "");
}

function extractNumericGid(gid?: string | null): string | null {
  if (!gid) {
    return null;
  }
  const parts = gid.split("/");
  const last = parts[parts.length - 1];
  return last && /^\d+$/.test(last) ? last : null;
}

function buildShopifyAdminOrderUrl(
  shop: string,
  draftOrderId?: string | null,
  orderId?: string | null,
): string {
  const shopHandle = getShopHandle(shop);
  const numericOrderId = extractNumericGid(orderId);
  if (numericOrderId) {
    return `https://admin.shopify.com/store/${shopHandle}/orders/${numericOrderId}`;
  }
  const numericDraftOrderId = extractNumericGid(draftOrderId);
  if (numericDraftOrderId) {
    return `https://admin.shopify.com/store/${shopHandle}/draft_orders/${numericDraftOrderId}`;
  }
  return `https://admin.shopify.com/store/${shopHandle}/draft_orders`;
}

function buildCadenceScheduleUrl(shop: string, scheduleId: string): string {
  const shopHandle = getShopHandle(shop);
  const appHandle = process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_APP_HANDLE;
  return `https://admin.shopify.com/store/${shopHandle}/apps/${appHandle}/app/schedules/${scheduleId}`;
}

function buildCadenceDashboardUrl(shop: string): string {
  const shopHandle = getShopHandle(shop);
  const appHandle = process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_APP_HANDLE;
  return `https://admin.shopify.com/store/${shopHandle}/apps/${appHandle}/app`;
}

function formatExecutionModeLabel(mode: ExecutionMode | string): string {
  switch (mode) {
    case "DRAFT_ONLY":
      return "Draft Only";
    case "SEND_INVOICE":
      return "Draft Created & Invoice Sent";
    case "COMPLETE_NET_TERMS":
      return "Completed Order (Net Terms / Payment Pending)";
    default:
      return String(mode);
  }
}

function formatUtcTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

interface EmailLayoutOptions {
  badgeText: string;
  badgeBg: string;
  badgeColor: string;
  title: string;
  intro: string;
  bodyHtml: string;
  primaryCta?: { label: string; url: string; bgColor?: string };
  secondaryLink?: { label: string; url: string };
  shop: string;
}

function renderEmailLayout(options: EmailLayoutOptions): string {
  const primaryButtonHtml = options.primaryCta
    ? `
      <div style="margin-top:24px;">
        <a href="${escapeHtml(options.primaryCta.url)}"
           style="display:inline-block;background-color:${options.primaryCta.bgColor || "#111827"};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:6px;">
          ${escapeHtml(options.primaryCta.label)}
        </a>
      </div>
    `
    : "";

  const secondaryLinkHtml = options.secondaryLink
    ? `
      <p style="margin:14px 0 0 0;font-size:13px;color:#4b5563;">
        <a href="${escapeHtml(options.secondaryLink.url)}" style="color:#1f2937;text-decoration:underline;">
          ${escapeHtml(options.secondaryLink.label)}
        </a>
      </p>
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f3f4f6;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px;border-bottom:1px solid #e5e7eb;background-color:#ffffff;">
                <div style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#111827;">
                  CadenceB2B
                </div>
                <div style="margin-top:12px;">
                  <span style="display:inline-block;background-color:${options.badgeBg};color:${options.badgeColor};font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;">
                    ${escapeHtml(options.badgeText)}
                  </span>
                </div>
                <h1 style="margin:12px 0 0 0;font-size:20px;line-height:1.35;color:#111827;">
                  ${escapeHtml(options.title)}
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px;">
                <p style="margin:0 0 18px 0;font-size:14px;line-height:1.6;color:#374151;">
                  ${escapeHtml(options.intro)}
                </p>
                ${options.bodyHtml}
                ${primaryButtonHtml}
                ${secondaryLinkHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background-color:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;line-height:1.5;">
                Sent by <strong>CadenceB2B</strong> for store <strong>${escapeHtml(options.shop)}</strong>.
                You can update your notification preferences in Shopify Admin &rarr; CadenceB2B &rarr; Settings.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderDetailRows(rows: Array<{ label: string; value: string }>): string {
  const trs = rows
    .map(
      (row) => `
      <tr>
        <td style="padding:8px 12px;font-size:13px;color:#6b7280;border-bottom:1px solid #f3f4f6;width:38%;vertical-align:top;">
          ${escapeHtml(row.label)}
        </td>
        <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#111827;border-bottom:1px solid #f3f4f6;vertical-align:top;">
          ${escapeHtml(row.value)}
        </td>
      </tr>`,
    )
    .join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;">
      ${trs}
    </table>
  `;
}

async function resolveRecipientEmail(
  shop: string,
  explicitEmail?: string | null,
): Promise<string | null> {
  if (explicitEmail !== undefined) {
    const trimmed = explicitEmail?.trim() || "";
    return trimmed.length > 0 ? trimmed : null;
  }

  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { notificationEmail: true },
  });

  const saved = settings?.notificationEmail?.trim() || "";
  return saved.length > 0 ? saved : null;
}

async function sendEmailSafe(params: {
  shop: string;
  toEmail?: string | null;
  subject: string;
  html: string;
  text: string;
}): Promise<NotificationResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    const reason = "RESEND_API_KEY is not configured.";
    console.warn(
      `[CadenceB2B Notifications] ${reason} Skipping email "${params.subject}" for ${params.shop}.`,
    );
    return { sent: false, skipped: true, reason };
  }

  let recipient: string | null = null;
  try {
    recipient = await resolveRecipientEmail(params.shop, params.toEmail);
  } catch (dbError) {
    console.warn(
      `[CadenceB2B Notifications] Failed to read ShopSettings for ${params.shop}. Skipping email "${params.subject}".`,
      dbError,
    );
    return {
      sent: false,
      skipped: true,
      reason: "Failed to read ShopSettings.",
    };
  }

  if (!recipient) {
    const reason = "No notificationEmail configured in ShopSettings.";
    console.warn(
      `[CadenceB2B Notifications] ${reason} Skipping email "${params.subject}" for ${params.shop}.`,
    );
    return { sent: false, skipped: true, reason };
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL;

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: recipient,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });

    if (error) {
      console.warn(
        `[CadenceB2B Notifications] Resend rejected email "${params.subject}" for ${params.shop}:`,
        error,
      );
      return {
        sent: false,
        skipped: false,
        reason: error.message || "Resend failed to send email.",
      };
    }

    return {
      sent: true,
      skipped: false,
      id: data?.id,
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unexpected Resend error.";
    console.warn(
      `[CadenceB2B Notifications] Unexpected error sending email "${params.subject}" for ${params.shop}:`,
      err,
    );
    return { sent: false, skipped: false, reason };
  }
}

export async function sendOrderExecutedEmail(
  params: OrderExecutedEmailParams,
): Promise<NotificationResult> {
  const executedAt = params.executedAt ?? new Date();
  const isCompletedOrder = Boolean(params.orderId);
  const resourceLabel = isCompletedOrder ? "Order Created" : "Draft Order Created";
  const orderDisplayName =
    params.orderName ||
    params.draftOrderName ||
    params.orderId ||
    params.draftOrderId ||
    "Created in Shopify";

  const adminOrderUrl = buildShopifyAdminOrderUrl(
    params.shop,
    params.draftOrderId,
    params.orderId,
  );
  const scheduleUrl = buildCadenceScheduleUrl(params.shop, params.scheduleId);
  const modeLabel = formatExecutionModeLabel(params.executionMode);

  const subject = `[CadenceB2B] Recurring order executed: ${params.scheduleName} (${orderDisplayName})`;

  const bodyHtml = renderDetailRows([
    { label: "Schedule", value: params.scheduleName },
    { label: "B2B Company", value: params.companyName },
    { label: "Company Location", value: params.companyLocationName },
    { label: resourceLabel, value: orderDisplayName },
    { label: "Execution Mode", value: modeLabel },
    { label: "Executed At", value: formatUtcTimestamp(executedAt) },
  ]);

  const html = renderEmailLayout({
    badgeText: "Order Executed",
    badgeBg: "#dcfce7",
    badgeColor: "#166534",
    title: `Recurring order created: ${orderDisplayName}`,
    intro: `Your scheduled B2B standing order "${params.scheduleName}" ran successfully for ${params.companyName} (${params.companyLocationName}).`,
    bodyHtml,
    primaryCta: {
      label: isCompletedOrder
        ? "View Order in Shopify Admin"
        : "View Draft Order in Shopify Admin",
      url: adminOrderUrl,
      bgColor: "#047857",
    },
    secondaryLink: {
      label: "Manage this schedule in CadenceB2B",
      url: scheduleUrl,
    },
    shop: params.shop,
  });

  const text = [
    `CadenceB2B — Recurring Order Executed`,
    ``,
    `Schedule: ${params.scheduleName}`,
    `Company: ${params.companyName}`,
    `Location: ${params.companyLocationName}`,
    `${resourceLabel}: ${orderDisplayName}`,
    `Execution Mode: ${modeLabel}`,
    `Executed At: ${formatUtcTimestamp(executedAt)}`,
    ``,
    `View in Shopify Admin: ${adminOrderUrl}`,
    `Manage schedule: ${scheduleUrl}`,
  ].join("\n");

  return sendEmailSafe({
    shop: params.shop,
    toEmail: params.toEmail,
    subject,
    html,
    text,
  });
}

export async function sendOverdueHoldEmail(
  params: OverdueHoldEmailParams,
): Promise<NotificationResult> {
  const checkedAt = params.checkedAt ?? new Date();
  const scheduleUrl = buildCadenceScheduleUrl(params.shop, params.scheduleId);
  const invoices =
    params.overdueOrderNames.length > 0
      ? params.overdueOrderNames
      : ["Overdue balance detected"];

  const subject = `[CadenceB2B] URGENT: Schedule paused (OVERDUE_HOLD) — ${params.companyName} / ${params.companyLocationName}`;

  const invoicesListHtml = invoices
    .map(
      (inv) =>
        `<span style="display:inline-block;margin:4px 6px 4px 0;padding:4px 10px;background-color:#fee2e2;color:#991b1b;font-weight:700;font-size:13px;border-radius:6px;border:1px solid #fecaca;">${escapeHtml(inv)}</span>`,
    )
    .join("");

  const bodyHtml = `
    ${renderDetailRows([
      { label: "Schedule", value: params.scheduleName },
      { label: "New Status", value: "OVERDUE_HOLD (Paused)" },
      { label: "B2B Company", value: params.companyName },
      { label: "Company Location", value: params.companyLocationName },
      { label: "Checked At", value: formatUtcTimestamp(checkedAt) },
    ])}
    <div style="margin-top:18px;padding:14px 16px;background-color:#fef2f2;border:1px solid #fecaca;border-radius:8px;">
      <div style="font-size:13px;font-weight:700;color:#991b1b;margin-bottom:8px;">
        Overdue Invoice(s) Detected
      </div>
      <div>${invoicesListHtml}</div>
      <p style="margin:10px 0 0 0;font-size:13px;color:#7f1d1d;line-height:1.5;">
        No new draft order or invoice was created. Once the overdue balance is resolved, resume this schedule in CadenceB2B.
      </p>
    </div>
  `;

  const html = renderEmailLayout({
    badgeText: "URGENT • OVERDUE HOLD",
    badgeBg: "#fee2e2",
    badgeColor: "#991b1b",
    title: `Schedule paused due to overdue invoice(s)`,
    intro: `CadenceB2B automatically paused "${params.scheduleName}" and placed it in OVERDUE_HOLD because ${params.companyLocationName} (${params.companyName}) has unpaid overdue invoice(s).`,
    bodyHtml,
    primaryCta: {
      label: "Review Schedule in CadenceB2B",
      url: scheduleUrl,
      bgColor: "#b91c1c",
    },
    shop: params.shop,
  });

  const text = [
    `URGENT: CadenceB2B Schedule Paused (OVERDUE_HOLD)`,
    ``,
    `Schedule: ${params.scheduleName}`,
    `Status: OVERDUE_HOLD`,
    `Company: ${params.companyName}`,
    `Location: ${params.companyLocationName}`,
    `Overdue Invoices: ${invoices.join(", ")}`,
    `Checked At: ${formatUtcTimestamp(checkedAt)}`,
    ``,
    `No new order was created. Review and resume in CadenceB2B:`,
    scheduleUrl,
  ].join("\n");

  return sendEmailSafe({
    shop: params.shop,
    toEmail: params.toEmail,
    subject,
    html,
    text,
  });
}

export async function sendExecutionFailedEmail(
  params: ExecutionFailedEmailParams,
): Promise<NotificationResult> {
  const failedAt = params.failedAt ?? new Date();
  const scheduleUrl = buildCadenceScheduleUrl(params.shop, params.scheduleId);

  const subject = `[CadenceB2B] Recurring order failed: ${params.scheduleName}`;

  const bodyHtml = `
    ${renderDetailRows([
      { label: "Schedule", value: params.scheduleName },
      { label: "B2B Company", value: params.companyName },
      { label: "Company Location", value: params.companyLocationName },
      { label: "Failed At", value: formatUtcTimestamp(failedAt) },
    ])}
    <div style="margin-top:18px;padding:14px 16px;background-color:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
      <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:6px;">
        Error Details
      </div>
      <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.5;color:#78350f;">${escapeHtml(params.errorMessage)}</pre>
    </div>
  `;

  const html = renderEmailLayout({
    badgeText: "Execution Failed",
    badgeBg: "#fef3c7",
    badgeColor: "#92400e",
    title: `Recurring schedule execution failed`,
    intro: `CadenceB2B encountered an error while attempting to execute "${params.scheduleName}" for ${params.companyName} (${params.companyLocationName}).`,
    bodyHtml,
    primaryCta: {
      label: "Inspect Schedule & Logs in CadenceB2B",
      url: scheduleUrl,
      bgColor: "#111827",
    },
    shop: params.shop,
  });

  const text = [
    `CadenceB2B — Recurring Order Execution Failed`,
    ``,
    `Schedule: ${params.scheduleName}`,
    `Company: ${params.companyName}`,
    `Location: ${params.companyLocationName}`,
    `Failed At: ${formatUtcTimestamp(failedAt)}`,
    ``,
    `Error: ${params.errorMessage}`,
    ``,
    `Inspect schedule & execution logs: ${scheduleUrl}`,
  ].join("\n");

  return sendEmailSafe({
    shop: params.shop,
    toEmail: params.toEmail,
    subject,
    html,
    text,
  });
}

export async function sendTestEmail(
  params: TestEmailParams,
): Promise<NotificationResult> {
  const sentAt = new Date();
  const dashboardUrl = buildCadenceDashboardUrl(params.shop);

  const subject = `[CadenceB2B] Test notification email for ${params.shop}`;

  const rows = [
    { label: "Store", value: params.shop },
    {
      label: "Default Timezone",
      value: params.defaultTimezone || "America/New_York",
    },
    { label: "Sent At", value: formatUtcTimestamp(sentAt) },
  ];

  const bodyHtml = renderDetailRows(rows);

  const html = renderEmailLayout({
    badgeText: "Test Email",
    badgeBg: "#dbeafe",
    badgeColor: "#1e40af",
    title: "Your CadenceB2B email notifications are ready",
    intro:
      "This is a test email from CadenceB2B. When recurring B2B schedules run, hit an Overdue Hold, or encounter an error, alerts will be delivered to this address.",
    bodyHtml,
    primaryCta: {
      label: "Open CadenceB2B Dashboard",
      url: dashboardUrl,
      bgColor: "#111827",
    },
    shop: params.shop,
  });

  const text = [
    `CadenceB2B — Test Notification Email`,
    ``,
    `Your CadenceB2B email notifications are configured and working.`,
    `Store: ${params.shop}`,
    `Default Timezone: ${params.defaultTimezone || "America/New_York"}`,
    `Sent At: ${formatUtcTimestamp(sentAt)}`,
    ``,
    `Open CadenceB2B: ${dashboardUrl}`,
  ].join("\n");

  return sendEmailSafe({
    shop: params.shop,
    toEmail: params.toEmail,
    subject,
    html,
    text,
  });
}
