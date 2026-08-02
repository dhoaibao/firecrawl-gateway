import {
  accountExportSchema,
  accountUpdateResponseSchema,
  accountViewSchema,
  credentialMetadataListSchema,
  credentialMetadataSchema,
  deletionResponseSchema,
  endpointViewSchema,
  gatewayTokenListSchema,
  gatewayTokenSchema,
  historyPageSchema,
  mfaSetupSchema,
  mfaStateSchema,
  portalOverviewSchema,
  quotaSummarySchema,
  recoveryCodesResponseSchema,
  securityEventListSchema,
  sessionListSchema,
  successResponseSchema,
  usagePageSchema,
} from "@firecrawl/contracts"
import { API_BASE, api, parseContract, type ContractSchema } from "@/lib/api"
import type { AccountView, CredentialMetadata, EndpointView, GatewayToken, HistoryItem, Paginated, PortalOverview, QuotaSummary, SecurityEventView, SessionView, UsageItem } from "./types"

const appPath = `${API_BASE}/app`

type ApiData<T> = { data: T }

type Reauthentication = {
  current_password: string
  mfa_code?: string
  recovery_code?: string
}

function dataRequest<T>(schema: ContractSchema<T>, request: Promise<unknown>): Promise<ApiData<T>> {
  return request.then((payload) => {
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new Error("The server returned an invalid response.")
    }
    return { data: parseContract(schema, (payload as { data: unknown }).data) }
  })
}

function responseRequest<T>(schema: ContractSchema<T>, request: Promise<unknown>): Promise<T> {
  return request.then((payload) => parseContract(schema, payload))
}

export const portalApi = {
  overview: () => dataRequest(portalOverviewSchema, api.get<unknown>(`${appPath}/overview`)),
  account: () => dataRequest(accountViewSchema, api.get<unknown>(`${appPath}/account`)),
  updateAccount: (body: { name?: string; funding_preference?: AccountView["funding_preference"] }) => dataRequest(accountUpdateResponseSchema, api.patch<unknown>(`${appPath}/account`, body)),
  endpoint: () => dataRequest(endpointViewSchema, api.get<unknown>(`${appPath}/endpoint`)),
  quota: () => dataRequest(quotaSummarySchema, api.get<unknown>(`${appPath}/quota`)),
  tokens: () => dataRequest(gatewayTokenListSchema, api.get<unknown>(`${appPath}/tokens`)),
  createToken: (body: { name: string; scopes?: string[]; expiresAt?: string | null; inactivityTimeoutSeconds?: number | null } & Reauthentication) => dataRequest(gatewayTokenSchema, api.post<unknown>(`${appPath}/tokens`, body)),
  revokeToken: (id: string, body: Reauthentication) => dataRequest(gatewayTokenSchema, api.delete<unknown>(`${appPath}/tokens/${encodeURIComponent(id)}`, body)),
  credentials: () => dataRequest(credentialMetadataListSchema, api.get<unknown>(`${appPath}/credentials`)),
  addCredential: (body: { value: string } & Reauthentication) => dataRequest(credentialMetadataSchema, api.post<unknown>(`${appPath}/credentials`, body)),
  replaceCredential: (id: string, body: { value: string } & Reauthentication) => dataRequest(credentialMetadataSchema, api.put<unknown>(`${appPath}/credentials/${encodeURIComponent(id)}`, body)),
  validateCredential: (id: string, body: Reauthentication) => dataRequest(credentialMetadataSchema, api.post<unknown>(`${appPath}/credentials/${encodeURIComponent(id)}/validate`, body)),
  deleteCredential: (id: string, body: Reauthentication) => api.delete<unknown>(`${appPath}/credentials/${encodeURIComponent(id)}`, body),
  usage: (params: URLSearchParams) => dataRequest(usagePageSchema, api.get<unknown>(`${appPath}/usage?${params.toString()}`)),
  history: (params: URLSearchParams) => dataRequest(historyPageSchema, api.get<unknown>(`${appPath}/request-history?${params.toString()}`)),
  sessions: () => dataRequest(sessionListSchema, api.get<unknown>(`${API_BASE}/auth/sessions`)),
  revokeSession: (id: string) => responseRequest(successResponseSchema, api.delete<unknown>(`${API_BASE}/auth/sessions/${encodeURIComponent(id)}`)),
  revokeAllSessions: () => responseRequest(successResponseSchema, api.post<unknown>(`${API_BASE}/auth/sessions/revoke-all`, {})),
  mfa: () => dataRequest(mfaStateSchema, api.get<unknown>(`${API_BASE}/auth/mfa`)),
  setupMfa: (body: Reauthentication) => dataRequest(mfaSetupSchema, api.post<unknown>(`${API_BASE}/auth/mfa/setup`, body)),
  enableMfa: (code: string) => responseRequest(recoveryCodesResponseSchema, api.post<unknown>(`${API_BASE}/auth/mfa/enable`, { code })),
  regenerateRecoveryCodes: (body: Reauthentication) => responseRequest(recoveryCodesResponseSchema, api.post<unknown>(`${API_BASE}/auth/mfa/recovery-codes`, body)),
  disableMfa: (body: Reauthentication) => responseRequest(successResponseSchema, api.post<unknown>(`${API_BASE}/auth/mfa/disable`, body)),
  securityEvents: () => dataRequest(securityEventListSchema, api.get<unknown>(`${appPath}/security/events`)),
  changePassword: (body: { current_password: string; new_password: string; mfa_code?: string }) => responseRequest(successResponseSchema, api.post<unknown>(`${API_BASE}/auth/password`, body)),
  requestEmailChange: (body: { email: string; current_password: string; mfa_code?: string }) => responseRequest(successResponseSchema, api.post<unknown>(`${API_BASE}/auth/email`, body)),
  exportAccount: (body: Reauthentication) => dataRequest(accountExportSchema, api.post<unknown>(`${appPath}/account/export`, body)),
  requestDeletion: (body: Reauthentication) => dataRequest(deletionResponseSchema, api.post<unknown>(`${appPath}/account/deletion-request`, body)),
  playground: (path: string, body: unknown, gatewayToken: string) => api.post<unknown>(`${appPath}/playground${path}`, body, { headers: { Authorization: `Bearer ${gatewayToken}` } }),
}

export type { CredentialMetadata, EndpointView, GatewayToken, HistoryItem, Paginated, PortalOverview, QuotaSummary, SecurityEventView, SessionView, UsageItem }
