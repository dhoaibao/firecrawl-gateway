/** Active virtual API keys one portal user may hold. */
export const PORTAL_MAX_API_KEYS = 10;
/**
 * Requests per minute applied to every key a portal user creates. A user's traffic
 * spends their own Cloud credits, so this protects the gateway, not the user's quota.
 */
export const PORTAL_DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
