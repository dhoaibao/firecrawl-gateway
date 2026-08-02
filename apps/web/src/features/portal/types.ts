import type {
  AccountView,
  CredentialMetadata,
  EndpointView,
  GatewayToken,
  HistoryItem,
  PortalOverview,
  PortalPagination,
  QuotaSummary,
  RequestSummary,
  SecurityEventView,
  SessionView,
  UsageItem,
} from "@firecrawl/contracts";

export type {
  AccountView,
  CredentialMetadata,
  EndpointView,
  GatewayToken,
  HistoryItem,
  PortalOverview,
  QuotaSummary,
  RequestSummary,
  SecurityEventView,
  SessionView,
  UsageItem,
};

export type Paginated<T> = {
  items: T[];
  pagination: PortalPagination;
};
