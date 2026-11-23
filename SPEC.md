# Project Spec: CadenceB2B (Shopify B2B Recurring Orders MVP)

## Goal

Build a clean, embedded Shopify Admin App in English for native Shopify B2B merchants. It automates recurring B2B standing orders per CompanyLocation using Shopify's GraphQL Admin API (2026-10), respects B2B Catalog pricing & Net Terms, and includes an automatic Overdue Invoice Hold.

## Tech Stack (Strict)

- Framework: Official Shopify React Router + TypeScript template
- UI: Shopify Polaris Web Components (use the exact `<s-*>` components already configured in this template, matching `app/routes/app._index.tsx` — do NOT install `@shopify/polaris` legacy React components)
- Database: PostgreSQL via Prisma (schema already defined in `prisma/schema.prisma`)
- Shopify API: GraphQL Admin API ONLY (zero REST calls)
- Emails: Resend SDK (only for Phase 2 alerts)

## Hard Boundaries (DO NOT BUILD IN MVP)

- NO storefront theme scripts or Online Store app embeds
- NO vaulted credit card auto-charging
- NO custom billing screens (we use Shopify Managed Pricing; check active plan limits via `currentAppInstallation { activeSubscriptions { name status } }`)
- Plan Limits:
  - Free plan (no active subscription): max 3 ACTIVE RecurringSchedules
  - Growth plan: max 30 ACTIVE RecurringSchedules
  - Scale plan: unlimited

## Execution Logic (Core Service: `app/services/scheduleRunner.server.ts`)

Write a reusable function `executeSchedule(admin, scheduleId, isManualTest = false)`:

1. Load `RecurringSchedule` with `lineItems`.
2. Idempotency check: if `!isManualTest` and `lastRunAt` is within the last 12 hours, abort safely.
3. If `pauseOnOverdue === true`, run `CheckLocationOverdueOrders` GraphQL query for `companyLocationId`.
   - If any order has `paymentTerms?.overdue === true` OR `displayFinancialStatus === "OVERDUE"`:
     - Update schedule status to `OVERDUE_HOLD`.
     - Create `ExecutionLog` with status `SKIPPED_OVERDUE`.
     - Return early without creating an order.
4. Run `draftOrderCreate` with:
   - `purchasingEntity.purchasingCompany` (`companyId`, `companyLocationId`, and `companyContactId` if present)
   - `lineItems` mapped to `{ variantId, quantity }`
   - `tags: ["cadence-b2b", "recurring-order"]`
   - `note`: schedule note
   - `poNumber`: if `poNumberPrefix` exists, format as `${poNumberPrefix}-${YYYYMMDD}`
5. Based on `executionMode`:
   - `DRAFT_ONLY`: stop after `draftOrderCreate`.
   - `SEND_INVOICE`: call `draftOrderInvoiceSend`.
   - `COMPLETE_NET_TERMS`: call `draftOrderComplete(id, paymentPending: true)`.
6. Record `ExecutionLog` (`SUCCESS` or `FAILED` with exact `userErrors`).
7. If `SUCCESS` and `!isManualTest`, update `lastRunAt = now()` and compute `nextRunAt` based on `frequency` (`WEEKLY` +7d, `BIWEEKLY` +14d, `MONTHLY` +1 month, `CUSTOM_DAYS` +`intervalDays`).

## Build Order

### Phase 1 (BUILD THIS NOW)

1. `app/services/shopifyB2B.server.ts`: GraphQL helpers for companies/locations, overdue check, draft order creation/invoice/completion, and active subscription plan check.
2. `app/services/scheduleRunner.server.ts`: Core execution engine described above.
3. `app/routes/app._index.tsx`: Polaris Dashboard with:
   - KPI summary cards (Active Schedules, Overdue Holds, Orders Executed Last 30 Days).
   - IndexTable of `RecurringSchedule` rows showing Company, Location, Frequency, Next Run Date, Mode, Status Badge (`ACTIVE`, `PAUSED`, `OVERDUE_HOLD`), and quick actions (Edit, Pause/Resume, **Run Now (Test)**).
   - EmptyState when zero schedules exist + banner if shop has no B2B Companies yet.
4. `app/routes/app.schedules.new.tsx` and `app/routes/app.schedules.$id.tsx`:
   - Polaris Form to pick Company -> CompanyLocation, select product variants via Shopify App Bridge ResourcePicker (`shopify.resourcePicker({ type: 'product', multiple: true })`), set quantities, frequency, execution mode, next run date, and `pauseOnOverdue` toggle.
   - Enforce Free plan limit (3 active schedules) with a clear Polaris Banner linking to Shopify Managed Pricing URL (`https://admin.shopify.com/store/${shopHandle}/charges/${appHandle}/pricing_plans`).
   - Show recent `ExecutionLog` table at the bottom of the edit page.

### Phase 2 (WAIT FOR MY CONFIRMATION BEFORE BUILDING)

- Secure cron endpoint `/api/cron/run-schedules` using `Authorization: Bearer ${process.env.CRON_SECRET}` that iterates offline `Session` records and executes due schedules (`status: ACTIVE`, `nextRunAt <= now()`).
- Resend email alerts when an order executes or hits `OVERDUE_HOLD`.
- Settings route `/app/settings` for merchant notification email.
