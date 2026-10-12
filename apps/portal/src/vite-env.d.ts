/// <reference types="vite/client" />

interface PortalRuntimeConfig {
  /** Origin of the gateway API, set by the container from PORTAL_API_BASE_URL. */
  apiBaseUrl?: string;
}

interface Window {
  __PORTAL_CONFIG__?: PortalRuntimeConfig;
}
