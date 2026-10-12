/** Active virtual API keys one portal user may hold. */
export const PORTAL_MAX_API_KEYS = 10;
/**
 * Requests per minute applied to every key a portal user creates. A user's traffic
 * spends their own Cloud credits, so this protects the gateway, not the user's quota.
 */
export const PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/** A user's admin-set overrides of the portal defaults; `null` means "use the default". */
export interface UserLimitOverrides {
  maxApiKeys: number | null;
  rateLimitPerMinute: number | null;
  monthlyQuota: number | null;
}

/** The limits that apply to a user's keys: their override, else the portal default. */
export function effectiveLimits(overrides: UserLimitOverrides) {
  return {
    maxApiKeys: overrides.maxApiKeys ?? PORTAL_MAX_API_KEYS,
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE,
    // No default quota: a user's credits are their own.
    monthlyQuota: overrides.monthlyQuota,
  };
}
