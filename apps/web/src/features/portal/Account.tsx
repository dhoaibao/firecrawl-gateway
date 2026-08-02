import { useEffect, useState } from "react"
import { Download, Loader2, Mail, Save, Trash2, UserRound } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import PageLayout from "@/components/PageLayout"
import PageSkeleton from "@/components/PageSkeleton"
import { useAuth } from "@/contexts/AuthContext"
import { useConfirmDialog } from "@/components/ConfirmDialog"
import { useToast } from "@/hooks/useToast"
import { portalApi } from "./api"
import type { AccountView } from "./types"

export default function Account() {
  const { user, refresh, logout } = useAuth()
  const [account, setAccount] = useState<AccountView | null>(null)
  const [name, setName] = useState("")
  const [funding, setFunding] = useState<AccountView["funding_preference"]>("auto")
  const [email, setEmail] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordMfa, setPasswordMfa] = useState("")
  const [emailPassword, setEmailPassword] = useState("")
  const [emailMfa, setEmailMfa] = useState("")
  const [deletionPassword, setDeletionPassword] = useState("")
  const [deletionMfa, setDeletionMfa] = useState("")
  const [exportPassword, setExportPassword] = useState("")
  const [exportMfa, setExportMfa] = useState("")
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const { addToast } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  useEffect(() => {
    document.title = "Account — Firecrawl Gateway"
    void portalApi.account().then((response) => { setAccount(response.data); setName(response.data.display_name); setFunding(response.data.funding_preference) }).catch((error) => addToast(error instanceof Error ? error.message : "Unable to load account", "error")).finally(() => setLoading(false))
  }, [addToast])

  async function saveProfile(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    try {
      const response = await portalApi.updateAccount({ name, funding_preference: funding })
      setAccount((current) => current ? { ...current, ...response.data.account } : response.data.account)
      await refresh()
      addToast("Account settings saved", "success")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to save account settings", "error")
    } finally {
      setSaving(false)
    }
  }

  async function changePassword(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (newPassword !== confirmPassword) { addToast("New passwords do not match", "error"); return }
    setSaving(true)
    try {
      await portalApi.changePassword({ current_password: currentPassword, new_password: newPassword, mfa_code: passwordMfa })
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setPasswordMfa("")
      addToast("Password changed. Sign in again to continue.", "success")
      await logout()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to change password", "error")
    } finally { setSaving(false) }
  }

  async function requestEmail(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    try {
      await portalApi.requestEmailChange({ email, current_password: emailPassword, mfa_code: emailMfa })
      setEmail(""); setEmailPassword(""); setEmailMfa("")
      addToast("Check the new address to confirm this change", "success")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to request email change", "error")
    } finally { setSaving(false) }
  }

  async function exportData() {
    setSaving(true)
    try {
      const response = await portalApi.exportAccount({
        current_password: exportPassword,
        ...(exportMfa.length === 6 ? { mfa_code: exportMfa } : { recovery_code: exportMfa }),
      })
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = "firecrawl-gateway-account-export.json"
      link.click()
      URL.revokeObjectURL(url)
      setExportPassword("")
      setExportMfa("")
      addToast("Account export downloaded", "success")
    } catch (error) { addToast(error instanceof Error ? error.message : "Unable to export account data", "error") } finally { setSaving(false) }
  }

  function requestDeletion() {
    confirm({ title: "Request account deletion", message: "This submits a deletion request. We will confirm immediate deletion and explain data retained for security, billing, or legal obligations.", confirmLabel: "Request deletion", variant: "danger", onConfirm: async () => { setSaving(true); try { const response = await portalApi.requestDeletion({ current_password: deletionPassword, ...(deletionMfa.length === 6 ? { mfa_code: deletionMfa } : { recovery_code: deletionMfa }) }); addToast(response.data.retention, "success"); setDeletionPassword(""); setDeletionMfa("") } catch (error) { addToast(error instanceof Error ? error.message : "Unable to request account deletion", "error") } finally { setSaving(false) } } })
  }

  if (loading || !account) return <PageSkeleton columns={2} rows={8} />

  return (
    <PageLayout title="Account" icon={UserRound}>
      <div className="space-y-4">
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-4 px-5 py-5"><div className="flex items-center gap-3"><div className="flex size-12 items-center justify-center rounded-xl border border-info-muted bg-info-muted/40 text-lg font-semibold text-info-fg">{(user?.name || user?.email || "U").slice(0, 1).toUpperCase()}</div><div><p className="font-semibold">{user?.name}</p><p className="text-sm text-muted-foreground">{user?.email}</p></div></div><div className="flex flex-wrap gap-2"><Badge variant={user?.email_verified_at ? "success" : "warning"}>{user?.email_verified_at ? "Email verified" : "Verification pending"}</Badge><Badge variant={account.status === "active" ? "success" : "warning"}>{account.status}</Badge></div></CardContent></Card>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card><CardHeader><CardTitle>Profile and funding</CardTitle><CardDescription>Controls for this workspace only.</CardDescription></CardHeader><CardContent><form onSubmit={saveProfile} className="space-y-4"><label className="block text-sm font-medium" htmlFor="account-name">Display name<Input id="account-name" className="mt-2" value={name} onChange={(event) => setName(event.target.value)} required /></label><label className="block text-sm font-medium" htmlFor="funding-preference">Funding preference<Select value={funding} onValueChange={(value) => setFunding(value as AccountView["funding_preference"])}><SelectTrigger id="funding-preference" className="mt-2 h-10 bg-surface-3"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Automatic</SelectItem><SelectItem value="byok">BYOK only</SelectItem><SelectItem value="included">Included only</SelectItem></SelectContent></Select></label><p className="text-xs text-muted-foreground">BYOK never consumes included allowance. Included-only requests fail safely when included access is unavailable.</p><Button type="submit" disabled={saving}><Save />Save changes</Button></form></CardContent></Card>
          <Card><CardHeader><CardTitle>Email address</CardTitle><CardDescription>A confirmation email is required before the address changes.</CardDescription></CardHeader><CardContent><form onSubmit={requestEmail} className="space-y-4"><label className="block text-sm font-medium" htmlFor="new-email">New email<Input id="new-email" className="mt-2" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><label className="block text-sm font-medium" htmlFor="email-password">Current password<Input id="email-password" className="mt-2" type="password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} autoComplete="current-password" required /></label><label className="block text-sm font-medium" htmlFor="email-mfa">Authenticator code if enabled<Input id="email-mfa" className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={emailMfa} onChange={(event) => setEmailMfa(event.target.value)} /></label><Button type="submit" variant="outline" disabled={saving}><Mail />Send confirmation</Button></form></CardContent></Card>
          <Card><CardHeader><CardTitle>Change password</CardTitle><CardDescription>Current credentials and MFA are checked before the change.</CardDescription></CardHeader><CardContent><form onSubmit={changePassword} className="space-y-4"><label className="block text-sm font-medium">Current password<Input className="mt-2" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-medium">New password<Input className="mt-2" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label><label className="block text-sm font-medium">Confirm password<Input className="mt-2" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label></div><label className="block text-sm font-medium">Authenticator code if enabled<Input className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={passwordMfa} onChange={(event) => setPasswordMfa(event.target.value)} /></label><Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin" />}Change password</Button></form></CardContent></Card>
          <Card><CardHeader><CardTitle>Data controls</CardTitle><CardDescription>Export metadata and request account deletion with retention explained.</CardDescription></CardHeader><CardContent className="space-y-5"><div><label className="block text-sm font-medium" htmlFor="export-password">Current password<Input id="export-password" className="mt-2" type="password" value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} autoComplete="current-password" /></label><label className="mt-3 block text-sm font-medium" htmlFor="export-mfa">Authenticator or recovery code<Input id="export-mfa" className="mt-2" value={exportMfa} onChange={(event) => setExportMfa(event.target.value)} autoComplete="one-time-code" /></label><Button variant="outline" className="mt-4" onClick={() => void exportData()} disabled={saving || !exportPassword}><Download />Download account export</Button></div><div className="border-t border-white/[0.06] pt-4"><label className="block text-sm font-medium" htmlFor="deletion-password">Current password<Input id="deletion-password" className="mt-2" type="password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} autoComplete="current-password" /></label><label className="mt-3 block text-sm font-medium" htmlFor="deletion-mfa">Authenticator or recovery code<Input id="deletion-mfa" className="mt-2" value={deletionMfa} onChange={(event) => setDeletionMfa(event.target.value)} autoComplete="one-time-code" /></label><Button variant="destructive" className="mt-4" onClick={requestDeletion} disabled={saving || !deletionPassword}><Trash2 />Request deletion</Button></div></CardContent></Card>
        </div>
      </div>
      {dialog}
    </PageLayout>
  )
}
