import { useMemo, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { B2BCompany } from "../services/shopifyB2B.server";

export type FrequencyValue = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM_DAYS";
export type ExecutionModeValue =
  | "DRAFT_ONLY"
  | "SEND_INVOICE"
  | "COMPLETE_NET_TERMS";
export type ScheduleStatusValue = "ACTIVE" | "PAUSED" | "OVERDUE_HOLD";

export interface ScheduleLineItemFormValue {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  quantity: number;
}

export interface ScheduleFormInitialValues {
  name: string;
  companyId: string;
  companyName: string;
  companyLocationId: string;
  companyLocationName: string;
  companyContactId: string;
  frequency: FrequencyValue;
  intervalDays: string;
  executionMode: ExecutionModeValue;
  nextRunDate: string;
  pauseOnOverdue: boolean;
  poNumberPrefix: string;
  note: string;
  status: ScheduleStatusValue;
  lineItems: ScheduleLineItemFormValue[];
}

export interface PlanLimitContext {
  planName: string;
  activeSchedulesCount: number;
  maxActiveSchedules: number | null;
  pricingUrl: string;
  canSetActive: boolean;
}

export interface ScheduleFormErrors {
  form?: string;
  name?: string;
  companyId?: string;
  companyLocationId?: string;
  lineItems?: string;
  intervalDays?: string;
  nextRunDate?: string;
}

interface ScheduleFormProps {
  mode: "create" | "edit";
  companies: B2BCompany[];
  companiesLoadError?: string | null;
  initialValues: ScheduleFormInitialValues;
  planContext: PlanLimitContext;
  serverErrors?: ScheduleFormErrors;
  isSubmitting: boolean;
  onSubmitValues: (payload: {
    name: string;
    companyId: string;
    companyName: string;
    companyLocationId: string;
    companyLocationName: string;
    companyContactId: string;
    frequency: FrequencyValue;
    intervalDays: string;
    executionMode: ExecutionModeValue;
    nextRunDate: string;
    pauseOnOverdue: boolean;
    poNumberPrefix: string;
    note: string;
    status: ScheduleStatusValue;
    lineItems: ScheduleLineItemFormValue[];
  }) => void;
}

export function ScheduleForm({
  mode,
  companies,
  companiesLoadError,
  initialValues,
  planContext,
  serverErrors,
  isSubmitting,
  onSubmitValues,
}: ScheduleFormProps) {
  const shopify = useAppBridge();

  const [name, setName] = useState(initialValues.name);
  const [companyId, setCompanyId] = useState(initialValues.companyId);
  const [companyName, setCompanyName] = useState(initialValues.companyName);
  const [companyLocationId, setCompanyLocationId] = useState(
    initialValues.companyLocationId,
  );
  const [companyLocationName, setCompanyLocationName] = useState(
    initialValues.companyLocationName,
  );
  const [companyContactId, setCompanyContactId] = useState(
    initialValues.companyContactId,
  );
  const [frequency, setFrequency] = useState<FrequencyValue>(
    initialValues.frequency,
  );
  const [intervalDays, setIntervalDays] = useState(initialValues.intervalDays);
  const [executionMode, setExecutionMode] = useState<ExecutionModeValue>(
    initialValues.executionMode,
  );
  const [nextRunDate, setNextRunDate] = useState(initialValues.nextRunDate);
  const [pauseOnOverdue, setPauseOnOverdue] = useState(
    initialValues.pauseOnOverdue,
  );
  const [poNumberPrefix, setPoNumberPrefix] = useState(
    initialValues.poNumberPrefix,
  );
  const [note, setNote] = useState(initialValues.note);
  const [status, setStatus] = useState<ScheduleStatusValue>(
    !planContext.canSetActive && initialValues.status === "ACTIVE"
      ? "PAUSED"
      : initialValues.status,
  );
  const [lineItems, setLineItems] = useState<ScheduleLineItemFormValue[]>(
    initialValues.lineItems,
  );
  const [clientErrors, setClientErrors] = useState<ScheduleFormErrors>({});

  const errors: ScheduleFormErrors = {
    ...serverErrors,
    ...clientErrors,
  };

  const companyOptions = useMemo(() => {
    const list = [...companies];
    if (
      initialValues.companyId &&
      !list.some((c) => c.id === initialValues.companyId)
    ) {
      list.unshift({
        id: initialValues.companyId,
        name: initialValues.companyName || initialValues.companyId,
        mainContactId: initialValues.companyContactId || null,
        locations: initialValues.companyLocationId
          ? [
              {
                id: initialValues.companyLocationId,
                name:
                  initialValues.companyLocationName ||
                  initialValues.companyLocationId,
                paymentTermsName: null,
              },
            ]
          : [],
        contacts: initialValues.companyContactId
          ? [
              {
                id: initialValues.companyContactId,
                isMainContact: true,
                displayName: initialValues.companyContactId,
                email: null,
              },
            ]
          : [],
      });
    }
    return list;
  }, [companies, initialValues]);

  const selectedCompany = useMemo(
    () => companyOptions.find((c) => c.id === companyId) ?? null,
    [companyOptions, companyId],
  );

  const locationOptions = useMemo(() => {
    const locs = selectedCompany ? [...selectedCompany.locations] : [];
    if (
      companyId === initialValues.companyId &&
      initialValues.companyLocationId &&
      !locs.some((l) => l.id === initialValues.companyLocationId)
    ) {
      locs.unshift({
        id: initialValues.companyLocationId,
        name:
          initialValues.companyLocationName || initialValues.companyLocationId,
        paymentTermsName: null,
      });
    }
    return locs;
  }, [selectedCompany, companyId, initialValues]);

  const selectedLocation = useMemo(
    () => locationOptions.find((l) => l.id === companyLocationId) ?? null,
    [locationOptions, companyLocationId],
  );

  const contactOptions = useMemo(() => {
    const contacts = selectedCompany ? [...selectedCompany.contacts] : [];
    if (
      companyId === initialValues.companyId &&
      initialValues.companyContactId &&
      !contacts.some((c) => c.id === initialValues.companyContactId)
    ) {
      contacts.unshift({
        id: initialValues.companyContactId,
        isMainContact: false,
        displayName: initialValues.companyContactId,
        email: null,
      });
    }
    return contacts;
  }, [selectedCompany, companyId, initialValues]);

  const handleCompanyChange = (newCompanyId: string) => {
    setCompanyId(newCompanyId);
    setClientErrors((prev) => ({
      ...prev,
      companyId: undefined,
      companyLocationId: undefined,
    }));

    const company = companyOptions.find((c) => c.id === newCompanyId);
    if (!company) {
      setCompanyName("");
      setCompanyLocationId("");
      setCompanyLocationName("");
      setCompanyContactId("");
      return;
    }

    setCompanyName(company.name);

    const firstLocation = company.locations[0] ?? null;
    setCompanyLocationId(firstLocation?.id ?? "");
    setCompanyLocationName(firstLocation?.name ?? "");

    const defaultContactId =
      company.mainContactId ?? company.contacts[0]?.id ?? "";
    setCompanyContactId(defaultContactId);
  };

  const handleLocationChange = (newLocationId: string) => {
    setCompanyLocationId(newLocationId);
    setClientErrors((prev) => ({ ...prev, companyLocationId: undefined }));
    const loc = locationOptions.find((l) => l.id === newLocationId);
    setCompanyLocationName(loc?.name ?? "");
  };

  const handlePickProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
    });

    if (!selected || selected.length === 0) {
      return;
    }

    setLineItems((prev) => {
      const byVariantId = new Map<string, ScheduleLineItemFormValue>();
      for (const item of prev) {
        byVariantId.set(item.variantId, item);
      }

      for (const product of selected) {
        const variants = product.variants ?? [];
        for (const variant of variants) {
          if (!variant.id) {
            continue;
          }
          const existing = byVariantId.get(variant.id);
          const rawVariantTitle =
            variant.title && variant.title !== "Default Title"
              ? variant.title
              : null;

          if (existing) {
            byVariantId.set(variant.id, {
              ...existing,
              productTitle: product.title || existing.productTitle,
              variantTitle: rawVariantTitle,
            });
          } else {
            byVariantId.set(variant.id, {
              variantId: variant.id,
              productTitle: product.title || "Product",
              variantTitle: rawVariantTitle,
              quantity: 1,
            });
          }
        }
      }

      return Array.from(byVariantId.values());
    });

    setClientErrors((prev) => ({ ...prev, lineItems: undefined }));
  };

  const handleQuantityChange = (variantId: string, rawValue: string) => {
    const parsed = Number.parseInt(rawValue, 10);
    const safeQuantity = Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
    setLineItems((prev) =>
      prev.map((item) =>
        item.variantId === variantId
          ? { ...item, quantity: safeQuantity }
          : item,
      ),
    );
  };

  const handleRemoveLineItem = (variantId: string) => {
    setLineItems((prev) => prev.filter((item) => item.variantId !== variantId));
  };

  const handleSubmit = () => {
    const nextErrors: ScheduleFormErrors = {};

    if (!name.trim()) {
      nextErrors.name = "Enter a schedule name.";
    }
    if (!companyId) {
      nextErrors.companyId = "Select a B2B Company.";
    }
    if (!companyLocationId) {
      nextErrors.companyLocationId = "Select a Company Location.";
    }
    if (lineItems.length === 0) {
      nextErrors.lineItems = "Add at least one product variant.";
    }
    if (frequency === "CUSTOM_DAYS") {
      const days = Number.parseInt(intervalDays, 10);
      if (Number.isNaN(days) || days < 1) {
        nextErrors.intervalDays = "Enter a valid interval of at least 1 day.";
      }
    }
    if (!nextRunDate) {
      nextErrors.nextRunDate = "Choose the next scheduled run date.";
    }

    if (Object.keys(nextErrors).length > 0) {
      setClientErrors(nextErrors);
      return;
    }

    setClientErrors({});
    onSubmitValues({
      name: name.trim(),
      companyId,
      companyName: companyName || selectedCompany?.name || companyId,
      companyLocationId,
      companyLocationName:
        companyLocationName || selectedLocation?.name || companyLocationId,
      companyContactId,
      frequency,
      intervalDays,
      executionMode,
      nextRunDate,
      pauseOnOverdue,
      poNumberPrefix: poNumberPrefix.trim(),
      note: note.trim(),
      status,
      lineItems,
    });
  };

  const showPlanLimitBanner =
    !planContext.canSetActive && planContext.maxActiveSchedules !== null;

  return (
    <s-stack direction="block" gap="base">
      {companiesLoadError && (
        <s-banner tone="warning" heading="Unable to load B2B Companies">
          <s-paragraph>{companiesLoadError}</s-paragraph>
        </s-banner>
      )}

      {showPlanLimitBanner && (
        <s-banner
          tone="warning"
          heading={`${planContext.planName} plan active schedule limit reached (${planContext.activeSchedulesCount}/${planContext.maxActiveSchedules})`}
        >
          <s-paragraph>
            Your current {planContext.planName} plan supports up to{" "}
            {planContext.maxActiveSchedules} active recurring{" "}
            {planContext.maxActiveSchedules === 1 ? "schedule" : "schedules"}.
            Upgrade in Shopify Managed Pricing to activate more schedules, or
            save this schedule as Paused.
          </s-paragraph>
          <s-button
            slot="secondary-actions"
            variant="secondary"
            href={planContext.pricingUrl}
            target="_top"
          >
            Upgrade plan
          </s-button>
        </s-banner>
      )}

      {errors.form && (
        <s-banner tone="critical" heading="Could not save schedule">
          <s-paragraph>{errors.form}</s-paragraph>
          {!planContext.canSetActive && (
            <s-button
              slot="secondary-actions"
              variant="secondary"
              href={planContext.pricingUrl}
              target="_top"
            >
              View pricing plans
            </s-button>
          )}
        </s-banner>
      )}

      <s-section heading="Schedule Details">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Schedule name"
            name="name"
            placeholder="e.g. Monthly Wholesale Restock"
            value={name}
            required
            error={errors.name}
            onInput={(e) => {
              setName(e.currentTarget.value);
              setClientErrors((prev) => ({ ...prev, name: undefined }));
            }}
          />

          <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
            <s-select
              label="B2B Company"
              name="companyId"
              value={companyId}
              placeholder="Select a company"
              required
              error={errors.companyId}
              disabled={companyOptions.length === 0}
              onChange={(e) => handleCompanyChange(e.currentTarget.value)}
            >
              <s-option value="">Select a company</s-option>
              {companyOptions.map((company) => (
                <s-option key={company.id} value={company.id}>
                  {company.name}
                </s-option>
              ))}
            </s-select>

            <s-select
              label="Company Location"
              name="companyLocationId"
              value={companyLocationId}
              placeholder="Select a location"
              required
              error={errors.companyLocationId}
              details={
                selectedLocation?.paymentTermsName
                  ? `Location Net Terms: ${selectedLocation.paymentTermsName}`
                  : "B2B Catalog pricing and Net Terms are inherited from this location."
              }
              disabled={!companyId || locationOptions.length === 0}
              onChange={(e) => handleLocationChange(e.currentTarget.value)}
            >
              <s-option value="">Select a location</s-option>
              {locationOptions.map((loc) => (
                <s-option key={loc.id} value={loc.id}>
                  {loc.name}
                </s-option>
              ))}
            </s-select>
          </s-grid>

          {contactOptions.length > 0 && (
            <s-select
              label="Company Contact (optional)"
              name="companyContactId"
              value={companyContactId}
              details="Attached to the B2B purchasing company on created draft orders and receives invoices when Send Invoice mode is used."
              onChange={(e) => setCompanyContactId(e.currentTarget.value)}
            >
              <s-option value="">None (use location default)</s-option>
              {contactOptions.map((contact) => (
                <s-option key={contact.id} value={contact.id}>
                  {contact.displayName}
                  {contact.email ? ` (${contact.email})` : ""}
                  {contact.isMainContact ? " — Main Contact" : ""}
                </s-option>
              ))}
            </s-select>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Line Items">
        <s-stack direction="block" gap="base">
          {errors.lineItems && (
            <s-banner tone="critical" heading="Line items required">
              <s-paragraph>{errors.lineItems}</s-paragraph>
            </s-banner>
          )}

          {lineItems.length === 0 ? (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">No products selected yet</s-text>
                  <s-text color="subdued">
                    Use Shopify Resource Picker to select products and variants.
                    B2B Catalog prices for the selected Company Location are
                    applied automatically when Shopify creates the draft order.
                  </s-text>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={() => void handlePickProducts()}
                  >
                    Select products
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="block" gap="base">
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header>Variant</s-table-header>
                  <s-table-header format="numeric">Quantity</s-table-header>
                  <s-table-header>Remove</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {lineItems.map((item) => (
                    <s-table-row key={item.variantId}>
                      <s-table-cell>
                        <s-text type="strong">{item.productTitle}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">
                          {item.variantTitle || "Default"}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-number-field
                          label="Quantity"
                          labelAccessibilityVisibility="exclusive"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={String(item.quantity)}
                          onInput={(e) =>
                            handleQuantityChange(
                              item.variantId,
                              e.currentTarget.value,
                            )
                          }
                          onChange={(e) =>
                            handleQuantityChange(
                              item.variantId,
                              e.currentTarget.value,
                            )
                          }
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-button
                          type="button"
                          variant="tertiary"
                          tone="critical"
                          onClick={() => handleRemoveLineItem(item.variantId)}
                        >
                          Remove
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>

              <s-stack direction="inline" gap="base">
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={() => void handlePickProducts()}
                >
                  Add more products
                </s-button>
              </s-stack>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Cadence & Execution">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
            <s-select
              label="Frequency"
              name="frequency"
              value={frequency}
              onChange={(e) =>
                setFrequency(e.currentTarget.value as FrequencyValue)
              }
            >
              <s-option value="WEEKLY">Weekly (every 7 days)</s-option>
              <s-option value="BIWEEKLY">Biweekly (every 14 days)</s-option>
              <s-option value="MONTHLY">Monthly</s-option>
              <s-option value="CUSTOM_DAYS">Custom interval (days)</s-option>
            </s-select>

            <s-date-field
              label="Next run date"
              name="nextRunDate"
              value={nextRunDate}
              required
              error={errors.nextRunDate}
              onChange={(e) => {
                setNextRunDate(e.currentTarget.value);
                setClientErrors((prev) => ({
                  ...prev,
                  nextRunDate: undefined,
                }));
              }}
            />
          </s-grid>

          {frequency === "CUSTOM_DAYS" && (
            <s-number-field
              label="Custom interval (days)"
              name="intervalDays"
              inputMode="numeric"
              min={1}
              step={1}
              value={intervalDays}
              required
              error={errors.intervalDays}
              details="Number of days between recurring order runs."
              onInput={(e) => {
                setIntervalDays(e.currentTarget.value);
                setClientErrors((prev) => ({
                  ...prev,
                  intervalDays: undefined,
                }));
              }}
            />
          )}

          <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
            <s-select
              label="Execution mode"
              name="executionMode"
              value={executionMode}
              details="Controls how Shopify handles each generated draft order."
              onChange={(e) =>
                setExecutionMode(e.currentTarget.value as ExecutionModeValue)
              }
            >
              <s-option value="DRAFT_ONLY">
                Draft Only — Create B2B draft order
              </s-option>
              <s-option value="SEND_INVOICE">
                Send Invoice — Create draft & email invoice
              </s-option>
              <s-option value="COMPLETE_NET_TERMS">
                Complete (Net Terms) — Finalize with payment pending
              </s-option>
            </s-select>

            <s-select
              label="Schedule status"
              name="status"
              value={status}
              details={
                !planContext.canSetActive
                  ? `Active limit reached on ${planContext.planName} plan. Save as Paused or upgrade.`
                  : "Active schedules execute automatically on their Next Run Date."
              }
              onChange={(e) =>
                setStatus(e.currentTarget.value as ScheduleStatusValue)
              }
            >
              <s-option value="ACTIVE" disabled={!planContext.canSetActive}>
                Active
              </s-option>
              <s-option value="PAUSED">Paused</s-option>
              {status === "OVERDUE_HOLD" && (
                <s-option value="OVERDUE_HOLD" disabled>
                  Overdue Hold
                </s-option>
              )}
            </s-select>
          </s-grid>

          <s-switch
            label="Overdue Invoice Hold (pause automatically if location has overdue invoices)"
            name="pauseOnOverdue"
            checked={pauseOnOverdue}
            details="Before creating a recurring order, CadenceB2B checks the Company Location for overdue Net Terms invoices. If any are overdue, the order is skipped and the schedule switches to Overdue Hold."
            onChange={(e) => setPauseOnOverdue(e.currentTarget.checked)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Order Metadata (Optional)">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="PO number prefix"
            name="poNumberPrefix"
            placeholder="e.g. AUTO-PO"
            value={poNumberPrefix}
            details="When set, generated orders receive a PO number formatted as PREFIX-YYYYMMDD."
            onInput={(e) => setPoNumberPrefix(e.currentTarget.value)}
          />

          <s-text-area
            label="Order note"
            name="note"
            rows={3}
            placeholder="Standing order notes shown on the Shopify draft order..."
            value={note}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-stack direction="inline" gap="base" justifyContent="end">
        <s-button variant="secondary" href="/app" disabled={isSubmitting}>
          Cancel
        </s-button>
        <s-button
          variant="primary"
          loading={isSubmitting}
          disabled={isSubmitting}
          onClick={handleSubmit}
        >
          {mode === "create" ? "Create schedule" : "Save changes"}
        </s-button>
      </s-stack>
    </s-stack>
  );
}
