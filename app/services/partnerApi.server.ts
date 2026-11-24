export interface PartnerSubscriptionItem {
  handle: string;
  description: string | null;
}

export interface PartnerActiveSubscription {
  billingPeriod: string | null;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  items: PartnerSubscriptionItem[];
}

export interface FetchActiveSubscriptionOptions {
  /**
   * When true, skips and clears any cached entry for this shopId before
   * querying the Shopify Partner API.
   */
  bypassCache?: boolean;
}

interface PartnerGraphQLError {
  message: string;
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

interface PartnerGraphQLResponse<TData> {
  data?: TData;
  errors?: PartnerGraphQLError[];
}

interface ActiveSubscriptionQueryData {
  activeSubscription: {
    billingPeriod: string | null;
    cancelAtEndOfCycle: boolean;
    trialEndsAt: string | null;
    items: Array<{
      handle: string;
      description: string | null;
    }>;
  } | null;
}

interface CachedSubscriptionEntry {
  subscription: PartnerActiveSubscription;
  expiresAt: number;
}

const PARTNER_API_VERSION = "2026-07";
const CACHE_TTL_MS = 5 * 60 * 1000;

// Intentionally omits the `#graphql` comment so Admin GraphQL codegen does not
// attempt to validate this Partner API operation against the Admin schema.
const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      items {
        handle
        description
      }
    }
  }
`;

const activeSubscriptionCache = new Map<string, CachedSubscriptionEntry>();

export function hasPlanHandleParam(
  requestOrUrl: Request | URL | string | null | undefined,
): boolean {
  if (!requestOrUrl) {
    return false;
  }

  try {
    const url =
      requestOrUrl instanceof URL
        ? requestOrUrl
        : new URL(
            typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url,
          );
    return url.searchParams.has("plan_handle");
  } catch {
    return false;
  }
}

export function invalidateActiveSubscriptionCache(shopId?: string): void {
  if (shopId) {
    activeSubscriptionCache.delete(shopId);
    return;
  }
  activeSubscriptionCache.clear();
}

export async function fetchActiveSubscription(
  shopId: string,
  options?: FetchActiveSubscriptionOptions,
): Promise<PartnerActiveSubscription | null> {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID?.trim();
  const accessToken = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN?.trim();
  const appId = process.env.SHOPIFY_APP_GID?.trim();

  const missingEnvVars: string[] = [];
  if (!orgId) {
    missingEnvVars.push("SHOPIFY_PARTNER_ORG_ID");
  }
  if (!accessToken) {
    missingEnvVars.push("SHOPIFY_PARTNER_API_ACCESS_TOKEN");
  }
  if (!appId) {
    missingEnvVars.push("SHOPIFY_APP_GID");
  }

  if (missingEnvVars.length > 0) {
    console.warn(
      `[Partner API] Missing required environment variable(s): ${missingEnvVars.join(", ")}. Falling back to the free plan.`,
    );
    return null;
  }

  const trimmedShopId = shopId.trim();
  if (!trimmedShopId) {
    throw new Error(
      "Cannot query Shopify Partner API activeSubscription without a valid shopId GID.",
    );
  }

  if (options?.bypassCache) {
    activeSubscriptionCache.delete(trimmedShopId);
  } else {
    const cached = activeSubscriptionCache.get(trimmedShopId);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.subscription;
      }
      activeSubscriptionCache.delete(trimmedShopId);
    }
  }

  const endpoint = `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken!,
    },
    body: JSON.stringify({
      query: ACTIVE_SUBSCRIPTION_QUERY,
      variables: {
        appId: appId!,
        shopId: trimmedShopId,
      },
    }),
  });

  if (response.status === 429) {
    throw new Error(
      "Shopify Partner API throttled the activeSubscription request (HTTP 429).",
    );
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const suffix = errorBody ? ` - ${errorBody.slice(0, 300)}` : "";
    throw new Error(
      `Shopify Partner API request failed with HTTP ${response.status}${suffix}`,
    );
  }

  const json =
    (await response.json()) as PartnerGraphQLResponse<ActiveSubscriptionQueryData>;

  if (json.errors && json.errors.length > 0) {
    const isThrottled = json.errors.some(
      (err) =>
        err.extensions?.code === "THROTTLED" || /throttl/i.test(err.message),
    );
    const messages = json.errors.map((err) => err.message).join("; ");
    throw new Error(
      isThrottled
        ? `Shopify Partner API throttled the activeSubscription request: ${messages}`
        : `Shopify Partner API GraphQL error: ${messages}`,
    );
  }

  if (
    !json.data ||
    typeof json.data !== "object" ||
    !("activeSubscription" in json.data)
  ) {
    throw new Error(
      "Shopify Partner API response did not include activeSubscription data.",
    );
  }

  const rawSubscription = json.data.activeSubscription;

  // Never cache null (unsubscribed / pending propagation) responses.
  if (!rawSubscription) {
    activeSubscriptionCache.delete(trimmedShopId);
    return null;
  }

  const subscription: PartnerActiveSubscription = {
    billingPeriod: rawSubscription.billingPeriod ?? null,
    cancelAtEndOfCycle: Boolean(rawSubscription.cancelAtEndOfCycle),
    trialEndsAt: rawSubscription.trialEndsAt ?? null,
    items: Array.isArray(rawSubscription.items)
      ? rawSubscription.items.map((item) => ({
          handle: item.handle,
          description: item.description ?? null,
        }))
      : [],
  };

  activeSubscriptionCache.set(trimmedShopId, {
    subscription,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return subscription;
}
