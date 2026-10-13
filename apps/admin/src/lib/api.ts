import { createApiClient } from "@firecrawl-gateway/api-client";

export { ApiError } from "@firecrawl-gateway/api-client";

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export const { api, apiUrl } = createApiClient({ baseUrl: API_BASE_URL });
