import { createApiClient } from "@firecrawl-gateway/api-client";

export { ApiError } from "@firecrawl-gateway/api-client";

/**
 * Where the gateway API lives. The container writes it into `/config.js` at start,
 * so one image serves every environment; `VITE_API_BASE_URL` covers `vite dev`.
 * Empty means the API shares this page's origin.
 */
export const API_BASE_URL = (
  window.__PORTAL_CONFIG__?.apiBaseUrl ||
  import.meta.env.VITE_API_BASE_URL ||
  ""
).replace(/\/$/, "");

export const { api, apiUrl } = createApiClient({ baseUrl: API_BASE_URL });
