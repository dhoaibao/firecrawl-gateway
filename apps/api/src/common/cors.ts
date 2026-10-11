import type { ApiConfig } from "./config";

/** Path prefix of the customer portal API; the only routes the portal origin may call. */
const PORTAL_API_PREFIX = "/portal/api/";

/**
 * Origins allowed to make credentialed cross-origin calls to a path. The portal is a
 * sibling site of the admin and carries user-supplied-account JavaScript, so it may
 * reach only the portal API and never the admin or gateway routes.
 */
export function corsOriginsFor(
  config: Pick<ApiConfig, "adminOrigin" | "apiOrigin" | "portalOrigin">,
  url: string,
): string[] {
  const origins = url.startsWith(PORTAL_API_PREFIX)
    ? [config.portalOrigin]
    : [config.adminOrigin, config.apiOrigin];
  return origins.filter(Boolean);
}
