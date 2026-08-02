import { useCallback, useEffect, useState } from "react"
import QRCode from "qrcode"
import { KeyRound, Loader2, LockKeyhole, RefreshCw, Shield, Smartphone, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import PageLayout from "@/components/PageLayout"
import PageSkeleton from "@/components/PageSkeleton"
import { useConfirmDialog } from "@/components/ConfirmDialog"
import { useToast } from "@/hooks/useToast"
import { useAuth } from "@/contexts/AuthContext"
import { formatDate } from "@/lib/date"
import { portalApi } from "./api"
import type { SecurityEventView, SessionView } from "./types"

type MfaAction = "setup" | "disable" | "regenerate" | null

export default function Security() {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [events, setEvents] = useState<SecurityEventView[]>([])
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [mfaAction, setMfaAction] = useState<MfaAction>(null)
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [currentPassword, setCurrentPassword] = useState("")
  const [mfaCode, setMfaCode] = useState("")
  const [recoveryCode, setRecoveryCode] = useState("")
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const { addToast } = useToast()
  const { logout } = useAuth()
  const { confirm, dialog } = useConfirmDialog()

  const load = useCallback(async () => {
    try {
      const [sessionResult, mfaResult, eventResult] = await Promise.all([portalApi.sessions(), portalApi.mfa(), portalApi.securityEvents()])
      setSessions(sessionResult.data)
      setMfaEnabled(mfaResult.data.enabled)
      setEvents(eventResult.data)
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to load security settings", "error")
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => { document.title = "Security — Firecrawl Gateway"; void load() }, [load])

  async function startMfa() {
    setSaving(true)
    try {
      const result = await portalApi.setupMfa({ current_password: currentPassword, mfa_code: mfaCode, recovery_code: recoveryCode })
      setSetup({ secret: result.data.secret, uri: result.data.uri, qr: await QRCode.toDataURL(result.data.uri, { width: 220, margin: 1 }) })
      setMfaAction("setup")
      setCurrentPassword("")
      setMfaCode("")
      setRecoveryCode("")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to start MFA setup", "error")
    } finally {
      setSaving(false)
    }
  }

  async function enableMfa() {
    if (!setup || !mfaCode.trim()) return
    setSaving(true)
    try {
      const result = await portalApi.enableMfa(mfaCode)
      setRecoveryCodes(result.recovery_codes)
      setMfaEnabled(true)
      setSetup(null)
      setMfaAction(null)
      setMfaCode("")
      addToast("MFA enabled", "success")
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to enable MFA", "error")
    } finally {
      setSaving(false)
    }
  }

  async function disableMfa() {
    setSaving(true)
    try {
      await portalApi.disableMfa({ current_password: currentPassword, mfa_code: mfaCode, recovery_code: recoveryCode })
      setMfaEnabled(false)
      setMfaAction(null)
      setCurrentPassword("")
      setMfaCode("")
      setRecoveryCode("")
      addToast("MFA disabled. Sign in again on other devices.", "success")
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to disable MFA", "error")
    } finally {
      setSaving(false)
    }
  }

  async function regenerate() {
    setSaving(true)
    try {
      const result = await portalApi.regenerateRecoveryCodes({ current_password: currentPassword, mfa_code: mfaCode, recovery_code: recoveryCode })
      setRecoveryCodes(result.recovery_codes)
      setMfaAction(null)
      setCurrentPassword("")
      setMfaCode("")
      setRecoveryCode("")
      addToast("Recovery codes regenerated", "success")
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to regenerate recovery codes", "error")
    } finally {
      setSaving(false)
    }
  }

  function revokeSession(session: SessionView) {
    confirm({ title: "Revoke session", message: "This device will need to sign in again.", confirmLabel: "Revoke session", variant: "warning", onConfirm: async () => { try { await portalApi.revokeSession(session.id); await load(); addToast("Session revoked", "success") } catch (error) { addToast(error instanceof Error ? error.message : "Unable to revoke session", "error") } } })
  }

  function revokeAllSessions() {
    confirm({ title: "Log out all sessions", message: "Every active device will need to sign in again, including this browser.", confirmLabel: "Log out all", variant: "danger", onConfirm: async () => { try { await portalApi.revokeAllSessions(); addToast("All sessions revoked", "success"); await logout() } catch (error) { addToast(error instanceof Error ? error.message : "Unable to revoke sessions", "error") } } })
  }

  if (loading) return <PageSkeleton columns={2} rows={7} />

  return (
    <PageLayout title="Security" icon={Shield}>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card><CardHeader><div className="flex items-center justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><Smartphone className="size-4 text-info-fg" />Multi-factor authentication</CardTitle><CardDescription className="mt-1">Protect sensitive account actions with an authenticator app.</CardDescription></div><Badge variant={mfaEnabled ? "success" : "warning"}>{mfaEnabled ? "Enabled" : "Not enabled"}</Badge></div></CardHeader><CardContent className="space-y-4">{recoveryCodes ? <div className="space-y-3"><p className="text-sm text-warning-fg">Save these codes offline. They are shown once and replace previous recovery codes.</p><div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-1 p-3 font-mono text-xs">{recoveryCodes.map((code) => <span key={code}>{code}</span>)}</div><Button variant="outline" onClick={() => setRecoveryCodes(null)}>I stored the codes</Button></div> : setup ? <div className="space-y-3"><p className="text-sm text-muted-foreground">Scan the QR code, then enter the current code to finish setup.</p><img src={setup.qr} alt="Authenticator setup QR code" width={220} height={220} className="mx-auto rounded-lg bg-white p-2" /><p className="text-xs text-muted-foreground">Manual key</p><code className="block break-all rounded-md bg-surface-1 p-2 font-mono text-xs">{setup.secret}</code><label className="block text-sm font-medium" htmlFor="setup-code">Authenticator code<Input id="setup-code" className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} /></label><Button onClick={() => void enableMfa()} disabled={saving || !mfaCode.trim()}>{saving && <Loader2 className="animate-spin" />}Enable MFA</Button></div> : mfaAction ? <div className="space-y-3"><div className="flex items-center justify-between"><p className="text-sm font-medium">{mfaAction === "disable" ? "Disable MFA" : mfaAction === "regenerate" ? "Regenerate recovery codes" : "Set up MFA"}</p><Button variant="ghost" size="sm" onClick={() => setMfaAction(null)}>Cancel</Button></div><label className="block text-sm font-medium" htmlFor="security-password">Current password<Input id="security-password" className="mt-2" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>{mfaAction !== "setup" && <label className="block text-sm font-medium" htmlFor="security-mfa-code">Authenticator code<Input id="security-mfa-code" className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} /></label>}<label className="block text-sm font-medium" htmlFor="security-recovery-code">Recovery code instead<Input id="security-recovery-code" className="mt-2 font-mono" autoComplete="one-time-code" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} /></label><Button variant={mfaAction === "disable" ? "destructive" : "default"} onClick={() => void (mfaAction === "setup" ? startMfa() : mfaAction === "disable" ? disableMfa() : regenerate())} disabled={saving || (mfaAction === "setup" && !currentPassword)}>{saving && <Loader2 className="animate-spin" />}{mfaAction === "setup" ? "Continue" : mfaAction === "disable" ? "Disable MFA" : "Regenerate codes"}</Button></div> : <div className="space-y-3"><p className="text-sm text-muted-foreground">{mfaEnabled ? "MFA protects your sensitive account controls." : "Enable MFA to protect password, email, token, and deletion actions."}</p><div className="flex flex-wrap gap-2">{!mfaEnabled && <Button onClick={() => setMfaAction("setup")}><Smartphone />Set up authenticator</Button>}{mfaEnabled && <><Button variant="outline" onClick={() => setMfaAction("regenerate")}><RefreshCw />Regenerate recovery codes</Button><Button variant="outline" className="text-danger-fg" onClick={() => setMfaAction("disable")}><Trash2 />Disable MFA</Button></>}</div></div>}</CardContent></Card>

        <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><LockKeyhole className="size-4 text-info-fg" />Active sessions</CardTitle><CardDescription>Revoke devices you no longer recognize.</CardDescription></div><Button variant="outline" size="sm" onClick={revokeAllSessions}><Trash2 />Log out all</Button></div></CardHeader><CardContent>{sessions.length === 0 ? <p className="text-sm text-muted-foreground">No active session records.</p> : <div className="space-y-2">{sessions.map((session) => <div key={session.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-surface-3 p-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{session.user_agent_label ? "Recognized browser" : "Browser session"}</p><p className="mt-1 text-xs text-muted-foreground">Last seen {formatDate(session.last_seen_at)}{session.revoked_at ? " · revoked" : ""}</p></div>{!session.revoked_at && <Button variant="outline" size="sm" onClick={() => revokeSession(session)}>Revoke</Button>}</div>)}</div>}</CardContent></Card>

        <Card className="xl:col-span-2"><CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-4 text-info-fg" />Security events</CardTitle><CardDescription>Recent account security activity. Device labels are privacy-reduced.</CardDescription></CardHeader><CardContent>{events.length === 0 ? <p className="text-sm text-muted-foreground">No security events to display.</p> : <div className="grid gap-2 sm:grid-cols-2">{events.map((event) => <div key={event.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-surface-3 px-3 py-2.5"><span className="text-sm">{event.event_type.replaceAll("_", " ")}</span><time className="shrink-0 text-xs text-muted-foreground">{formatDate(event.created_at)}</time></div>)}</div>}</CardContent></Card>
      </div>
      {dialog}
    </PageLayout>
  )
}
