import { useCallback, useEffect, useState } from "react"
import { Copy, Key, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import DataTable from "@/components/DataTable"
import EmptyState from "@/components/EmptyState"
import PageLayout from "@/components/PageLayout"
import PageSkeleton from "@/components/PageSkeleton"
import { useConfirmDialog } from "@/components/ConfirmDialog"
import { useToast } from "@/hooks/useToast"
import { formatDate } from "@/lib/date"
import { portalApi } from "./api"
import type { GatewayToken } from "./types"

function statusVariant(status: GatewayToken["status"]) {
  if (status === "active") return "success" as const
  if (status === "revoked" || status === "expired") return "destructive" as const
  return "warning" as const
}

export default function Tokens() {
  const [tokens, setTokens] = useState<GatewayToken[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState("*")
  const [expiresAt, setExpiresAt] = useState("")
  const [inactivityDays, setInactivityDays] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [mfaCode, setMfaCode] = useState("")
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<GatewayToken | null>(null)
  const [revokingToken, setRevokingToken] = useState<GatewayToken | null>(null)
  const [revocationPassword, setRevocationPassword] = useState("")
  const [revocationMfa, setRevocationMfa] = useState("")
  const [revoking, setRevoking] = useState(false)
  const { addToast } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  const load = useCallback(async () => {
    try {
      setTokens((await portalApi.tokens()).data)
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to load gateway tokens", "error")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [addToast])

  useEffect(() => { document.title = "Tokens — Firecrawl Gateway"; void load() }, [load])

  function clearCreateForm() {
    setName("")
    setScopes("*")
    setExpiresAt("")
    setInactivityDays("")
    setCurrentPassword("")
    setMfaCode("")
  }

  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreating(true)
    try {
      const result = await portalApi.createToken({
        name: name.trim(),
        scopes: scopes.split(",").map((scope) => scope.trim()).filter(Boolean),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        inactivityTimeoutSeconds: inactivityDays ? Number(inactivityDays) * 24 * 60 * 60 : null,
        current_password: currentPassword,
        ...(mfaCode.length === 6 ? { mfa_code: mfaCode } : mfaCode ? { recovery_code: mfaCode } : {}),
      })
      setCreatedToken(result.data)
      setDialogOpen(false)
      clearCreateForm()
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to create token", "error")
    } finally {
      setCreating(false)
    }
  }

  function revoke(token: GatewayToken) {
    confirm({
      title: "Revoke gateway token",
      message: `Requests using ${token.name} will stop working immediately. This action cannot be undone.`,
      confirmLabel: "Continue",
      variant: "warning",
      onConfirm: async () => {
        setRevocationPassword("")
        setRevocationMfa("")
        setRevokingToken(token)
      },
    })
  }

  async function submitRevocation(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!revokingToken) return
    setRevoking(true)
    try {
      await portalApi.revokeToken(revokingToken.id, {
        current_password: revocationPassword,
        ...(revocationMfa.length === 6 ? { mfa_code: revocationMfa } : { recovery_code: revocationMfa }),
      })
      setRevokingToken(null)
      setRevocationPassword("")
      setRevocationMfa("")
      addToast("Gateway token revoked", "success")
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to revoke token", "error")
    } finally {
      setRevoking(false)
    }
  }

  async function copySecret() {
    if (!createdToken?.key) return
    try {
      await navigator.clipboard.writeText(createdToken.key)
      addToast("Token copied. It will not be available again.", "success")
    } catch {
      addToast("Unable to copy from this browser", "error")
    }
  }

  if (loading) return <PageSkeleton columns={6} rows={6} />

  return (
    <PageLayout title="Gateway Tokens" icon={Key} actions={<><Button variant="outline" size="sm" onClick={() => { setRefreshing(true); void load() }} disabled={refreshing}><RefreshCw className={refreshing ? "animate-spin" : ""} />Refresh</Button><Button size="sm" onClick={() => setDialogOpen(true)}><Plus />Create token</Button></>}>
      <Card className="mb-5 border-info-muted bg-info-muted/20"><div className="flex items-start gap-3 px-5 py-4"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-info-fg" /><div className="text-sm"><p className="font-medium text-info-fg">Secrets are shown once</p><p className="mt-1 text-muted-foreground">Only a prefix and metadata are retained after creation. If you lose a token, create a replacement—existing tokens cannot be copied back.</p></div></div></Card>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">{[{ label: "Active", value: tokens.filter((token) => token.status === "active").length, tone: "text-success-fg" }, { label: "Expired / inactive", value: tokens.filter((token) => token.status === "expired" || token.status === "inactive").length, tone: "text-warning-fg" }, { label: "Revoked", value: tokens.filter((token) => token.status === "revoked").length, tone: "text-danger-fg" }, { label: "Never used", value: tokens.filter((token) => !token.last_used_at && token.status === "active").length, tone: "text-warning-fg" }].map((item) => <div key={item.label} className="rounded-lg border border-white/[0.06] bg-surface-2 px-4 py-3"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</p><p className={`mt-1 font-mono text-2xl font-semibold ${item.tone}`}>{item.value}</p></div>)}</div>
      <div className="overflow-hidden rounded-lg border border-white/[0.06] bg-surface-2"><DataTable columns={[{ key: "name", header: "Name", render: (token) => <div><p className="font-medium">{token.name}</p><p className="font-mono text-xs text-muted-foreground">{token.key_prefix}...</p></div> }, { key: "scope", header: "Scopes", render: (token) => <span className="font-mono text-xs text-muted-foreground">{token.scopes.join(", ")}</span> }, { key: "status", header: "Status", render: (token) => <Badge variant={statusVariant(token.status)}>{token.status}</Badge> }, { key: "created", header: "Created", className: "text-muted-foreground", render: (token) => formatDate(token.created_at) }, { key: "last", header: "Last used", className: "text-muted-foreground", render: (token) => token.last_used_at ? formatDate(token.last_used_at) : "Never" }, { key: "expiry", header: "Expiry", className: "text-muted-foreground", render: (token) => token.expires_at ? formatDate(token.expires_at) : "No expiry" }, { key: "actions", header: "", align: "right", render: (token) => token.status === "active" ? <Button variant="outline" size="sm" className="text-danger-fg" onClick={() => revoke(token)}><Trash2 />Revoke</Button> : null }]} data={tokens} keyExtractor={(token) => token.id} emptyState={<EmptyState icon={Key} title="No gateway tokens" description="Create a scoped token to connect your Firecrawl client." action={{ label: "Create token", onClick: () => setDialogOpen(true) }} />} /></div>
      <Dialog open={dialogOpen} title="Create gateway token" description="Choose the smallest scope set your integration needs. Reauthentication is required for this security-sensitive action." onClose={() => { setDialogOpen(false); clearCreateForm() }} footer={<><Button variant="outline" size="sm" onClick={() => { setDialogOpen(false); clearCreateForm() }}>Cancel</Button><Button type="submit" form="create-token-form" size="sm" disabled={creating || !currentPassword}>{creating ? "Creating..." : "Create token"}</Button></>}><form id="create-token-form" className="space-y-4" onSubmit={create}><label className="block text-sm font-medium" htmlFor="token-name">Name<Input id="token-name" className="mt-2" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production app" required autoComplete="off" /></label><label className="block text-sm font-medium" htmlFor="token-scopes">Scopes<Input id="token-scopes" className="mt-2 font-mono text-xs" value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="v1:scrape, v2:scrape" /></label><p className="text-xs text-muted-foreground">Use <code>*</code> for all supported paths, or comma-separated scope values such as <code>v2:scrape</code>.</p><label className="block text-sm font-medium" htmlFor="token-expires">Expires at (optional)<Input id="token-expires" className="mt-2" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label><label className="block text-sm font-medium" htmlFor="token-inactivity">Revoke after inactivity (days)<Input id="token-inactivity" className="mt-2" type="number" min="1" value={inactivityDays} onChange={(event) => setInactivityDays(event.target.value)} placeholder="Optional; bounded by server policy" /></label><label className="block text-sm font-medium" htmlFor="token-current-password">Current password<Input id="token-current-password" className="mt-2" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label className="block text-sm font-medium" htmlFor="token-mfa">Authenticator or recovery code<Input id="token-mfa" className="mt-2" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} autoComplete="one-time-code" /></label></form></Dialog>
      <Dialog open={Boolean(revokingToken)} title="Revoke gateway token" description="Confirm your current credentials to revoke this token." onClose={() => { if (!revoking) setRevokingToken(null) }} footer={<><Button variant="outline" size="sm" onClick={() => setRevokingToken(null)} disabled={revoking}>Cancel</Button><Button variant="destructive" type="submit" form="revoke-token-form" size="sm" disabled={revoking || !revocationPassword}>{revoking ? "Revoking..." : "Revoke token"}</Button></>}><form id="revoke-token-form" className="space-y-4" onSubmit={submitRevocation}><p className="text-sm text-muted-foreground">{revokingToken?.name}</p><label className="block text-sm font-medium" htmlFor="revoke-current-password">Current password<Input id="revoke-current-password" className="mt-2" type="password" value={revocationPassword} onChange={(event) => setRevocationPassword(event.target.value)} autoComplete="current-password" required /></label><label className="block text-sm font-medium" htmlFor="revoke-mfa">Authenticator or recovery code<Input id="revoke-mfa" className="mt-2" value={revocationMfa} onChange={(event) => setRevocationMfa(event.target.value)} autoComplete="one-time-code" /></label></form></Dialog>
      <Dialog open={Boolean(createdToken?.key)} title="Gateway token created" description="Copy this secret now. It is not available after this dialog closes." onClose={() => setCreatedToken(null)} footer={<Button onClick={() => setCreatedToken(null)}>I stored the token</Button>}><div className="space-y-3"><div className="flex gap-2"><code className="min-w-0 flex-1 break-all rounded-md border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-xs">{createdToken?.key}</code><Button variant="outline" size="sm" onClick={() => void copySecret()}><Copy />Copy</Button></div><p className="text-xs text-warning-fg">The browser will not persist this token. Never send it in a URL or commit it to source control.</p></div></Dialog>
      {dialog}
    </PageLayout>
  )
}
