import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { Activity, Bell, Database, Gauge, LockKeyhole, Settings, Shield, Users, type LucideIcon } from "lucide-react"
import PageLayout from "@/components/PageLayout"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, ApiError } from "@/lib/api"

type JsonObject = Record<string, unknown>
type Mutation = () => Promise<void>

const pageConfig: Record<string, { title: string; icon: LucideIcon; endpoint: string }> = {
  "/admin": { title: "Operator overview", icon: Activity, endpoint: "" },
  "/admin/capacity": { title: "Capacity control center", icon: Gauge, endpoint: "/capacity" },
  "/admin/accounts": { title: "Accounts", icon: Users, endpoint: "/accounts" },
  "/admin/waitlist": { title: "Waitlist", icon: Users, endpoint: "/capacity/waitlist" },
  "/admin/infrastructure": { title: "Infrastructure sources", icon: Database, endpoint: "/infrastructure" },
  "/admin/usage": { title: "Usage analytics", icon: Gauge, endpoint: "/usage" },
  "/admin/requests": { title: "Request analytics", icon: Activity, endpoint: "/requests" },
  "/admin/notifications": { title: "Notifications", icon: Bell, endpoint: "/notifications" },
  "/admin/security": { title: "Security events", icon: Shield, endpoint: "/security" },
  "/admin/configuration": { title: "Configuration", icon: Settings, endpoint: "/configuration" },
}

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {} }
function text(value: unknown): string { return value === null || value === undefined ? "—" : String(value) }
function list(value: unknown): JsonObject[] { return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [] }
function value(data: JsonObject, key: string): string { return text(data[key]) }

function useOperatorData(endpoint: string) {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [degraded, setDegraded] = useState(false)
  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    setDegraded(false)
    return api.get<{ data: unknown }>(`/api/v1/admin${endpoint}`).then((response) => setData(response.data)).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.code === "operator_read_only") { setDegraded(true); setData(null) }
      setError(reason instanceof ApiError ? reason.message : "Unable to load operator data")
    }).finally(() => setLoading(false))
  }, [endpoint])
  useEffect(() => { void refresh() }, [refresh])
  return { data, error, loading, degraded, refresh }
}

function StepUpDialog({ onSubmit, onCancel }: { onSubmit: (password: string, code: string, recovery: boolean) => Promise<void>; onCancel: () => void }) {
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [useRecoveryCode, setUseRecoveryCode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try { await onSubmit(password, code, useRecoveryCode) } catch (reason) { setError(reason instanceof Error ? reason.message : "Step-up failed") } finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
    <form onSubmit={submit} className="w-full max-w-md rounded-xl border border-white/[0.08] bg-surface-2 p-6 shadow-xl">
      <div className="flex items-center gap-3"><LockKeyhole className="size-5 text-brand" /><h2 className="text-lg font-semibold">Confirm operator change</h2></div>
      <p className="mt-2 text-sm text-muted-foreground">Enter your password and authenticator or recovery code. This authorization lasts ten minutes.</p>
      <div className="mt-5 grid gap-3"><Input required type="password" autoComplete="current-password" placeholder="Current password" value={password} onChange={(event) => setPassword(event.target.value)} /><Input required inputMode={useRecoveryCode ? "text" : "numeric"} placeholder={useRecoveryCode ? "Recovery code" : "Authenticator code"} value={code} onChange={(event) => setCode(event.target.value)} /><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={useRecoveryCode} onChange={(event) => setUseRecoveryCode(event.target.checked)} />Use a recovery code</label></div>
      {error && <p className="mt-3 text-sm text-danger-fg">{error}</p>}
      <div className="mt-6 flex justify-end gap-2"><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button><Button disabled={busy}>{busy ? "Verifying…" : "Verify and continue"}</Button></div>
    </form>
  </div>
}

function useMutations(readOnly: boolean, refresh: () => Promise<unknown>) {
  const [pending, setPending] = useState<Mutation | null>(null)
  const [stepUp, setStepUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (mutation: Mutation) => {
    if (readOnly) { setError("Database security is degraded; changes are disabled."); return }
    setError(null)
    try { await mutation(); await refresh() } catch (reason) {
      if (reason instanceof ApiError && reason.code === "step_up_required") { setPending(() => mutation); setStepUp(true) }
      else setError(reason instanceof Error ? reason.message : "The change failed")
    }
  }, [readOnly, refresh])
  const dialog = stepUp ? <StepUpDialog onCancel={() => { setStepUp(false); setPending(null) }} onSubmit={async (password, code, recovery) => {
    await api.post("/api/v1/admin/step-up", { current_password: password, ...(recovery ? { recovery_code: code } : { mfa_code: code }) })
    const action = pending
    setStepUp(false); setPending(null)
    if (action) { await action(); await refresh() }
  }} /> : null
  return { run, error, dialog }
}

function Reason({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Input required minLength={3} placeholder="Reason for this change" value={value} onChange={(event) => onChange(event.target.value)} />
}
function Section({ title, children }: { title: string; children: ReactNode }) { return <Card className="p-5"><h2 className="mb-4 text-base font-semibold">{title}</h2>{children}</Card> }
function Table({ rows, columns }: { rows: JsonObject[]; columns: string[] }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-white/[0.08] text-muted-foreground">{columns.map((column) => <th className="px-3 py-2 font-medium" key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr className="border-b border-white/[0.05]" key={String(row.id ?? row.account_id ?? index)}>{columns.map((column) => <td className="max-w-[280px] px-3 py-3 align-top" key={column}>{text(row[column])}</td>)}</tr>)}</tbody></table>{rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">No records found.</p>}</div>
}

function CapacityView({ data, run, error }: { data: unknown; run: (mutation: Mutation) => Promise<void>; error: string | null }) {
  const policy = object(data); const [grant, setGrant] = useState(value(policy, "default_grant")); const [reason, setReason] = useState("")
  return <div className="grid gap-4"><Section title="Included capacity policy"><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Input type="number" min="0" aria-label="Default grant" value={grant} onChange={(event) => setGrant(event.target.value)} /><Reason value={reason} onChange={setReason} /><Button onClick={() => void run(() => api.patch("/api/v1/admin/capacity/policy", { default_grant: Number(grant), reason }))}>Save policy</Button></div>{error && <p className="mt-3 text-sm text-danger-fg">{error}</p>}<pre className="mt-4 overflow-auto rounded bg-surface-3 p-3 text-xs">{JSON.stringify(policy, null, 2)}</pre></Section><Section title="Safety notes"><p className="text-sm text-muted-foreground">Changes are server-validated for commitment ceilings, UTC periods, permanent admission slots, and BYOK access.</p></Section></div>
}

function WaitlistView({ data, run }: { data: unknown; run: (mutation: Mutation) => Promise<void> }) {
  const rows = list(data); const [reason, setReason] = useState(""); const [account, setAccount] = useState("")
  return <div className="grid gap-4"><Section title="Waitlist controls"><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]"><Input placeholder="Account ID" value={account} onChange={(event) => setAccount(event.target.value)} /><Reason value={reason} onChange={setReason} /><Button onClick={() => void run(() => api.post("/api/v1/admin/capacity/waitlist/admit", { account_id: account, reason }))}>Admit</Button><Button variant="outline" onClick={() => void run(() => api.post("/api/v1/admin/capacity/waitlist/skip", { account_id: account, reason }))}>Skip</Button></div></Section><Section title="Queued accounts"><Table rows={rows} columns={["account_id", "position", "status", "created_at"]} /></Section></div>
}

function AccountsView({ data, run }: { data: unknown; run: (mutation: Mutation) => Promise<void> }) {
  const result = object(data); const rows = list(result.users); const [query, setQuery] = useState(""); const [reason, setReason] = useState("")
  return <div className="grid gap-4"><Section title="Search accounts"><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); window.location.search = query ? `?q=${encodeURIComponent(query)}` : "" }}><Input placeholder="Email or name" value={query} onChange={(event) => setQuery(event.target.value)} /><Button>Search</Button></form><Reason value={reason} onChange={setReason} /></Section><Section title={`${rows.length} accounts`}><div className="grid gap-3">{rows.map((row) => <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.06] p-3" key={String(row.id)}><div><p className="font-medium">{value(row, "email")}</p><p className="text-xs text-muted-foreground">{value(row, "id")} · {value(row, "status")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void run(() => api.post(`/api/v1/admin/accounts/${String(row.id)}/suspend`, { reason }))}>Suspend</Button><Button size="sm" variant="outline" onClick={() => void run(() => api.post(`/api/v1/admin/accounts/${String(row.id)}/reactivate`, { reason }))}>Reactivate</Button><Button size="sm" variant="destructive" onClick={() => { if (window.confirm("Revoke all tokens for this account?")) void run(() => api.post(`/api/v1/admin/accounts/${String(row.id)}/tokens/revoke-all`, { reason })) }}>Revoke tokens</Button></div></div>)}</div></Section></div>
}

function InfrastructureView({ data, run }: { data: unknown; run: (mutation: Mutation) => Promise<void> }) {
  const rows = list(data); const [reason, setReason] = useState(""); const [credential, setCredential] = useState(""); const [sourceId, setSourceId] = useState("")
  return <div className="grid gap-4"><Section title="Infrastructure sources"><Reason value={reason} onChange={setReason} /><div className="mt-4 grid gap-3">{rows.map((row) => <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.06] p-3" key={String(row.id)}><div><p className="font-medium">{value(row, "name")}</p><p className="text-xs text-muted-foreground">{value(row, "id")} · {value(row, "status")} · concurrency {value(row, "concurrency")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void run(() => api.post(`/api/v1/admin/infrastructure/${String(row.id)}/test`, { reason }))}>Test</Button>{value(row, "status") === "paused" ? <Button size="sm" onClick={() => void run(() => api.post(`/api/v1/admin/infrastructure/${String(row.id)}/activate`, { reason }))}>Activate</Button> : <Button size="sm" variant="outline" onClick={() => void run(() => api.post(`/api/v1/admin/infrastructure/${String(row.id)}/pause`, { reason }))}>Pause</Button>}</div></div>)}</div></Section><Section title="Rotate operator credential"><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Input placeholder="Source ID" value={sourceId} onChange={(event) => setSourceId(event.target.value)} /><Input type="password" placeholder="New credential (never displayed)" value={credential} onChange={(event) => setCredential(event.target.value)} /><Button onClick={() => void run(() => api.post("/api/v1/admin/infrastructure/credentials", { source_id: sourceId, value: credential, reason }))}>Store</Button></div></Section></div>
}

function NotificationsView({ data, run }: { data: unknown; run: (mutation: Mutation) => Promise<void> }) {
  const rows = list(data)
  return <Section title="Notification center"><div className="grid gap-3">{rows.map((row) => <div className="rounded-lg border border-white/[0.06] p-4" key={String(row.id)}><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{value(row, "type")} · {value(row, "severity")}</span><span className="text-xs text-muted-foreground">email: {value(row, "email_status")} ({value(row, "email_attempts")} attempts)</span></div><p className="mt-1 text-xs text-muted-foreground">{value(row, "state")} · {value(row, "last_occurred_at")}</p><div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => void run(() => api.post(`/api/v1/admin/notifications/${String(row.id)}/acknowledge`, { reason: "Acknowledged from notification center" }))}>Acknowledge</Button><Button size="sm" variant="outline" onClick={() => void run(() => api.post(`/api/v1/admin/notifications/${String(row.id)}/resolve`, { reason: "Resolved from notification center" }))}>Resolve</Button></div></div>)}</div></Section>
}

function AnalyticsView({ data }: { data: unknown }) { const result = object(data); return <div className="grid gap-4"><Section title="Summary"><pre className="overflow-auto rounded bg-surface-3 p-4 text-xs">{JSON.stringify(result.summary ?? result, null, 2)}</pre></Section><Section title="Hourly series"><Table rows={list(result.hourly)} columns={["hour", "requests", "errors", "p50_ms", "p95_ms"]} /></Section><Section title="Highest usage accounts"><Table rows={list(result.accounts)} columns={["account_id", "requests", "included", "byok"]} /></Section></div> }
function SimpleView({ data, title, columns }: { data: unknown; title: string; columns: string[] }) { const rows = list(data); return <Section title={title}><Table rows={rows} columns={columns} /></Section> }

export default function OperatorPage() {
  const location = useLocation(); const config = pageConfig[location.pathname] || pageConfig["/admin"]; const queryEndpoint = config.endpoint + (location.search || ""); const { data, error, loading, degraded, refresh } = useOperatorData(queryEndpoint); const root = object(data); const readOnly = degraded || root.read_only === true; const mutations = useMutations(readOnly, refresh)
  const content = useMemo(() => {
    if (location.pathname === "/admin/capacity") return <CapacityView data={data} run={mutations.run} error={mutations.error} />
    if (location.pathname === "/admin/waitlist") return <WaitlistView data={data} run={mutations.run} />
    if (location.pathname === "/admin/accounts") return <AccountsView data={data} run={mutations.run} />
    if (location.pathname === "/admin/infrastructure") return <InfrastructureView data={data} run={mutations.run} />
    if (location.pathname === "/admin/notifications") return <NotificationsView data={data} run={mutations.run} />
    if (location.pathname === "/admin/usage" || location.pathname === "/admin/requests") return <AnalyticsView data={data} />
    if (location.pathname === "/admin/security") return <SimpleView data={data} title="Recent security events" columns={["event_type", "user_id", "created_at", "metadata"]} />
    if (location.pathname === "/admin/configuration") return <ConfigurationView data={data} run={mutations.run} />
    return <Section title="Operator readiness"><pre className="overflow-auto rounded bg-surface-3 p-4 text-xs">{JSON.stringify(data, null, 2)}</pre></Section>
  }, [data, location.pathname, mutations.error, mutations.run])
  return <PageLayout title={config.title} icon={config.icon}><div className="mb-4 rounded-lg border border-info-muted bg-info-muted/20 px-4 py-3 text-xs text-info-fg">Operator data is scoped to authenticated platform operators. Times and period boundaries are UTC.</div>{readOnly && <div className="mb-4 rounded-lg border border-warning-muted bg-warning-muted/20 px-4 py-3 text-sm text-warning-fg">Read-only degraded mode: database schema or security prerequisites are unavailable. Changes are disabled.</div>}{error && <Card className="mb-4 border-danger-muted p-5 text-sm text-danger-fg">{error}</Card>}{loading ? <Card className="p-5 text-sm text-muted-foreground">Loading bounded operator data…</Card> : content}{mutations.dialog}</PageLayout>
}

function ConfigurationView({ data, run }: { data: unknown; run: (mutation: Mutation) => Promise<void> }) { const rows = list(data); const [routeMode, setRouteMode] = useState(""); const [reason, setReason] = useState(""); return <Section title="Restricted configuration"><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Input placeholder="default_route_mode" value={routeMode} onChange={(event) => setRouteMode(event.target.value)} /><Reason value={reason} onChange={setReason} /><Button onClick={() => void run(() => api.put("/api/v1/admin/configuration", { default_route_mode: routeMode, reason }))}>Save</Button></div><div className="mt-4"><Table rows={rows} columns={["key", "configured", "value"]} /></div></Section> }
