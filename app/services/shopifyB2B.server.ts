import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  fetchActiveSubscription,
  hasPlanHandleParam,
  type PartnerActiveSubscription,
  type PartnerSubscriptionItem,
} from "./partnerApi.server";

export type AdminClient = Pick<AdminApiContext, "graphql">;

export interface GraphQLUserError {
  field?: string[] | null;
  message: string;
}

export interface B2BCompanyContact {
  id: string;
  isMainContact: boolean;
  displayName: string;
  email: string | null;
}

export interface B2BCompanyLocation {
  id: string;
  name: string;
  paymentTermsName: string | null;
}

export interface B2BCompany {
  id: string;
  name: string;
  mainContactId: string | null;
  locations: B2BCompanyLocation[];
  contacts: B2BCompanyContact[];
}

export interface OverdueOrderInfo {
  id: string;
  name: string;
  displayFinancialStatus: string | null;
  overdue: boolean;
}

export interface OverdueCheckResult {
  hasOverdue: boolean;
  overdueOrders: OverdueOrderInfo[];
}

export interface DraftOrderLineItemInput {
  variantId: string;
  quantity: number;
}

export interface CreateB2BDraftOrderParams {
  companyId: string;
  companyLocationId: string;
  companyContactId?: string | null;
  lineItems: DraftOrderLineItemInput[];
  note?: string | null;
  poNumber?: string | null;
  tags?: string[];
}

export interface DraftOrderMutationResult {
  draftOrderId: string | null;
  draftOrderName: string | null;
  orderId: string | null;
  orderName: string | null;
  userErrors: GraphQLUserError[];
}

export type PlanTier = "FREE" | "GROWTH" | "SCALE";

export interface ActivePlanInfo {
  tier: PlanTier;
  planName: string;
  maxActiveSchedules: number | null;
  appHandle: string;
  billingPeriod: string | null;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  items: PartnerSubscriptionItem[];
}

export interface GetActivePlanOptions {
  bypassCache?: boolean;
  requestUrl?: Request | URL | string | null;
}

interface GraphQLErrorItem {
  message: string;
}

interface GraphQLJsonResponse<TData> {
  data?: TData;
  errors?: GraphQLErrorItem[];
}

const DEFAULT_APP_HANDLE = "cadenceb2b";

export function formatUserErrors(userErrors: GraphQLUserError[]): string {
  if (userErrors.length === 0) {
    return "Unknown Shopify API error.";
  }

  return userErrors
    .map((err) => {
      const fieldPrefix =
        err.field && err.field.length > 0 ? `${err.field.join(".")}: ` : "";
      return `${fieldPrefix}${err.message}`;
    })
    .join("; ");
}

export function buildManagedPricingUrl(
  shopDomain: string,
  appHandle?: string,
): string {
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/i, "");
  const safeAppHandle =
    appHandle?.trim() ||
    process.env.SHOPIFY_APP_HANDLE?.trim() ||
    DEFAULT_APP_HANDLE;
  return `https://admin.shopify.com/store/${storeHandle}/charges/${safeAppHandle}/pricing_plans`;
}

async function parseGraphQLResponse<TData>(
  response: Response,
): Promise<TData> {
  const json = (await response.json()) as GraphQLJsonResponse<TData>;
  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message).join("; ");
    throw new Error(`Shopify GraphQL error: ${messages}`);
  }
  if (!json.data) {
    throw new Error("Shopify GraphQL response contained no data.");
  }
  return json.data;
}

const GET_B2B_COMPANIES_QUERY = `#graphql
  query GetB2BCompanies($first: Int!, $after: String) {
    companies(first: $first, after: $after, sortKey: NAME) {
      nodes {
        id
        name
        mainContact {
          id
        }
        locations(first: 50) {
          nodes {
            id
            name
            buyerExperienceConfiguration {
              paymentTermsTemplate {
                name
              }
            }
          }
        }
        contacts(first: 25) {
          nodes {
            id
            isMainContact
            customer {
              displayName
              email
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface GetB2BCompaniesData {
  companies: {
    nodes: Array<{
      id: string;
      name: string;
      mainContact: { id: string } | null;
      locations: {
        nodes: Array<{
          id: string;
          name: string;
          buyerExperienceConfiguration: {
            paymentTermsTemplate: {
              name: string;
            } | null;
          } | null;
        }>;
      };
      contacts: {
        nodes: Array<{
          id: string;
          isMainContact: boolean;
          customer: {
            displayName: string;
            email: string | null;
          } | null;
        }>;
      };
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

export async function getB2BCompanies(
  admin: AdminClient,
): Promise<B2BCompany[]> {
  const companies: B2BCompany[] = [];
  let after: string | null = null;
  let pagesFetched = 0;
  const maxPages = 5;

  while (pagesFetched < maxPages) {
    const response: Response = await admin.graphql(GET_B2B_COMPANIES_QUERY, {
      variables: {
        first: 50,
        after,
      },
    });
    const data: GetB2BCompaniesData =
      await parseGraphQLResponse<GetB2BCompaniesData>(response);

    for (const node of data.companies.nodes) {
      companies.push({
        id: node.id,
        name: node.name,
        mainContactId: node.mainContact?.id ?? null,
        locations: node.locations.nodes.map((loc) => ({
          id: loc.id,
          name: loc.name,
          paymentTermsName:
            loc.buyerExperienceConfiguration?.paymentTermsTemplate?.name ??
            null,
        })),
        contacts: node.contacts.nodes.map((contact) => ({
          id: contact.id,
          isMainContact: contact.isMainContact,
          displayName:
            contact.customer?.displayName ||
            contact.customer?.email ||
            contact.id,
          email: contact.customer?.email ?? null,
        })),
      });
    }

    if (
      !data.companies.pageInfo.hasNextPage ||
      !data.companies.pageInfo.endCursor
    ) {
      break;
    }

    after = data.companies.pageInfo.endCursor;
    pagesFetched += 1;
  }

  return companies;
}

const HAS_B2B_COMPANIES_QUERY = `#graphql
  query HasB2BCompanies {
    companies(first: 1) {
      nodes {
        id
      }
    }
  }
`;

interface HasB2BCompaniesData {
  companies: {
    nodes: Array<{ id: string }>;
  };
}

export async function hasAnyB2BCompanies(admin: AdminClient): Promise<boolean> {
  const response = await admin.graphql(HAS_B2B_COMPANIES_QUERY);
  const data = await parseGraphQLResponse<HasB2BCompaniesData>(response);
  return data.companies.nodes.length > 0;
}

const CHECK_LOCATION_OVERDUE_ORDERS_QUERY = `#graphql
  query CheckLocationOverdueOrders($companyLocationId: ID!) {
    companyLocation(id: $companyLocationId) {
      id
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          displayFinancialStatus
          paymentTerms {
            overdue
          }
        }
      }
    }
  }
`;

interface CheckLocationOverdueOrdersData {
  companyLocation: {
    id: string;
    orders: {
      nodes: Array<{
        id: string;
        name: string;
        displayFinancialStatus: string | null;
        paymentTerms: {
          overdue: boolean;
        } | null;
      }>;
    };
  } | null;
}

export async function checkLocationOverdueOrders(
  admin: AdminClient,
  companyLocationId: string,
): Promise<OverdueCheckResult> {
  const response = await admin.graphql(CHECK_LOCATION_OVERDUE_ORDERS_QUERY, {
    variables: { companyLocationId },
  });
  const data =
    await parseGraphQLResponse<CheckLocationOverdueOrdersData>(response);

  const orders = data.companyLocation?.orders.nodes ?? [];
  const overdueOrders: OverdueOrderInfo[] = [];

  for (const order of orders) {
    const isOverdue =
      order.paymentTerms?.overdue === true ||
      order.displayFinancialStatus === "OVERDUE";

    if (isOverdue) {
      overdueOrders.push({
        id: order.id,
        name: order.name,
        displayFinancialStatus: order.displayFinancialStatus,
        overdue: isOverdue,
      });
    }
  }

  return {
    hasOverdue: overdueOrders.length > 0,
    overdueOrders,
  };
}

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation CadenceDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface DraftOrderCreateData {
  draftOrderCreate: {
    draftOrder: {
      id: string;
      name: string;
    } | null;
    userErrors: GraphQLUserError[];
  };
}

export async function createB2BDraftOrder(
  admin: AdminClient,
  params: CreateB2BDraftOrderParams,
): Promise<DraftOrderMutationResult> {
  const purchasingCompany: {
    companyId: string;
    companyLocationId: string;
    companyContactId?: string;
  } = {
    companyId: params.companyId,
    companyLocationId: params.companyLocationId,
  };

  if (params.companyContactId) {
    purchasingCompany.companyContactId = params.companyContactId;
  }

  const input: Record<string, unknown> = {
    purchasingEntity: {
      purchasingCompany,
    },
    lineItems: params.lineItems.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    tags: params.tags ?? ["cadence-b2b", "recurring-order"],
  };

  if (params.note && params.note.trim().length > 0) {
    input.note = params.note.trim();
  }

  if (params.poNumber && params.poNumber.trim().length > 0) {
    input.poNumber = params.poNumber.trim();
  }

  const response = await admin.graphql(DRAFT_ORDER_CREATE_MUTATION, {
    variables: { input },
  });
  const data = await parseGraphQLResponse<DraftOrderCreateData>(response);
  const payload = data.draftOrderCreate;

  return {
    draftOrderId: payload.draftOrder?.id ?? null,
    draftOrderName: payload.draftOrder?.name ?? null,
    orderId: null,
    orderName: null,
    userErrors: payload.userErrors ?? [],
  };
}

const DRAFT_ORDER_INVOICE_SEND_MUTATION = `#graphql
  mutation CadenceDraftOrderInvoiceSend($id: ID!) {
    draftOrderInvoiceSend(id: $id) {
      draftOrder {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface DraftOrderInvoiceSendData {
  draftOrderInvoiceSend: {
    draftOrder: {
      id: string;
      name: string;
    } | null;
    userErrors: GraphQLUserError[];
  };
}

export async function sendDraftOrderInvoice(
  admin: AdminClient,
  draftOrderId: string,
): Promise<DraftOrderMutationResult> {
  const response = await admin.graphql(DRAFT_ORDER_INVOICE_SEND_MUTATION, {
    variables: { id: draftOrderId },
  });
  const data = await parseGraphQLResponse<DraftOrderInvoiceSendData>(response);
  const payload = data.draftOrderInvoiceSend;

  return {
    draftOrderId: payload.draftOrder?.id ?? draftOrderId,
    draftOrderName: payload.draftOrder?.name ?? null,
    orderId: null,
    orderName: null,
    userErrors: payload.userErrors ?? [],
  };
}

const DRAFT_ORDER_COMPLETE_MUTATION = `#graphql
  mutation CadenceDraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        name
        order {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface DraftOrderCompleteData {
  draftOrderComplete: {
    draftOrder: {
      id: string;
      name: string;
      order: {
        id: string;
        name: string;
      } | null;
    } | null;
    userErrors: GraphQLUserError[];
  };
}

export async function completeDraftOrderNetTerms(
  admin: AdminClient,
  draftOrderId: string,
): Promise<DraftOrderMutationResult> {
  const response = await admin.graphql(DRAFT_ORDER_COMPLETE_MUTATION, {
    variables: {
      id: draftOrderId,
      paymentPending: true,
    },
  });
  const data = await parseGraphQLResponse<DraftOrderCompleteData>(response);
  const payload = data.draftOrderComplete;

  return {
    draftOrderId: payload.draftOrder?.id ?? draftOrderId,
    draftOrderName: payload.draftOrder?.name ?? null,
    orderId: payload.draftOrder?.order?.id ?? null,
    orderName: payload.draftOrder?.order?.name ?? null,
    userErrors: payload.userErrors ?? [],
  };
}

const GET_SHOP_ID_QUERY = `#graphql
  query GetShopId {
    shop {
      id
    }
  }
`;

interface GetShopIdData {
  shop: {
    id: string;
  };
}

export async function getShopId(admin: AdminClient): Promise<string> {
  const response = await admin.graphql(GET_SHOP_ID_QUERY);
  const data = await parseGraphQLResponse<GetShopIdData>(response);
  if (!data.shop?.id) {
    throw new Error("Shopify Admin API did not return a shop ID.");
  }
  return data.shop.id;
}

function mapSubscriptionToPlan(
  subscription: PartnerActiveSubscription | null,
  appHandle: string,
): ActivePlanInfo {
  const items = subscription?.items ?? [];
  const normalizedHandles = items.map((item) =>
    item.handle.trim().toLowerCase(),
  );
  const sharedMeta = {
    appHandle,
    billingPeriod: subscription?.billingPeriod ?? null,
    cancelAtEndOfCycle: subscription?.cancelAtEndOfCycle ?? false,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    items,
  };

  if (
    normalizedHandles.some(
      (handle) => handle === "scale" || handle.includes("scale"),
    )
  ) {
    return {
      tier: "SCALE",
      planName: "Scale",
      maxActiveSchedules: null,
      ...sharedMeta,
    };
  }

  if (
    normalizedHandles.some(
      (handle) => handle === "growth" || handle.includes("growth"),
    )
  ) {
    return {
      tier: "GROWTH",
      planName: "Growth",
      maxActiveSchedules: 30,
      ...sharedMeta,
    };
  }

  return {
    tier: "FREE",
    planName: "Free",
    maxActiveSchedules: 1,
    ...sharedMeta,
  };
}

export async function getActivePlan(
  admin: AdminClient,
  options?: GetActivePlanOptions,
): Promise<ActivePlanInfo> {
  const appHandle =
    process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_APP_HANDLE;
  const shopId = await getShopId(admin);
  const bypassCache =
    Boolean(options?.bypassCache) || hasPlanHandleParam(options?.requestUrl);
  const subscription = await fetchActiveSubscription(shopId, { bypassCache });

  return mapSubscriptionToPlan(subscription, appHandle);
}
