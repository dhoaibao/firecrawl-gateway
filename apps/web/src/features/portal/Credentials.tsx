import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Cloud, Loader2, Plus, RefreshCw, RotateCcw, Trash2, WifiOff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import PageLayout from "@/components/PageLayout"
import PageSkeleton from "@/components/PageSkeleton"
import EmptyState from "@/components/EmptyState"
import { useConfirmDialog } from "@/components/ConfirmDialog"
import { useToast } from "@/hooks/useToast"
import { formatDate } from "@/lib/date"
import { portalApi } from "./api"
import type { CredentialMetadata } from "./types"

export default function Credentials() {
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [value, setValue] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [mfaCode, setMfaCode] = useState("")
  const [replacing, setReplacing] = useState<CredentialMetadata | null>(null)
  const [deleting, setDeleting] = useState<CredentialMetadata | null>(null)
  const [deletionPassword, setDeletionPassword] = useState("")
  const [deletionMfa, setDeletionMfa] = useState("")
  const [validating, setValidating] = useState<CredentialMetadata | null>(null)
  const [validationPassword, setValidationPassword] = useState("")
  const [validationMfa, setValidationMfa] = useState("")
  const [saving, setSaving] = useState(false)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [validatingBusy, setValidatingBusy] = useState(false)
  const { addToast } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  const load = useCallback(async () => {
    try {
      setCredentials((await portalApi.credentials()).data)
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to load credentials", "error")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [addToast])

  useEffect(() => { document.title = "BYOK Credentials — Firecrawl Gateway"; void load() }, [load])

  function clearEditor() {
    setValue("")
    setCurrentPassword("")
    setMfaCode("")
    setReplacing(null)
  }

  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    try {
      const auth = {
        current_password: currentPassword,
        ...(mfaCode.length === 6 ? { mfa_code: mfaCode } : mfaCode ? { recovery_code: mfaCode } : {}),
      }
      if (replacing) await portalApi.replaceCredential(replacing.id, { value: value.trim(), ...auth })
      else await portalApi.addCredential({ value: value.trim(), ...auth })
      const wasReplacing = Boolean(replacing)
      clearEditor()
      setDialogOpen(false)
      addToast(wasReplacing ? "Credential replaced and validated" : "Credential added and validated", "success")
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to save credential", "error")
    } finally {
      setSaving(false)
    }
  }

  function validate(credential: CredentialMetadata) {
    setValidationPassword("")
    setValidationMfa("")
    setValidating(credential)
  }

  async function submitValidation(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validating) return
    setValidatingBusy(true)
    try {
      const result = await portalApi.validateCredential(validating.id, {
        current_password: validationPassword,
        ...(validationMfa.length === 6 ? { mfa_code: validationMfa } : { recovery_code: validationMfa }),
      })
      setCredentials((items) => items.map((item) => item.id === validating.id ? result.data : item))
      setValidating(null)
      addToast(result.data.status === "valid" ? "Connection is healthy" : "Provider rejected this credential", result.data.status === "valid" ? "success" : "error")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to test connection", "error")
    } finally {
      setValidatingBusy(false)
    }
  }

  function remove(credential: CredentialMetadata) {
    confirm({ title: "Delete BYOK credential", message: "Requests using this credential will stop using BYOK until you add a replacement.", confirmLabel: "Continue", variant: "warning", onConfirm: async () => { setDeletionPassword(""); setDeletionMfa(""); setDeleting(credential) } })
  }

  async function submitDeletion(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!deleting) return
    setDeletingBusy(true)
    try {
      await portalApi.deleteCredential(deleting.id, {
        current_password: deletionPassword,
        ...(deletionMfa.length === 6 ? { mfa_code: deletionMfa } : { recovery_code: deletionMfa }),
      })
      setDeleting(null)
      setDeletionPassword("")
      setDeletionMfa("")
      addToast("Credential deleted", "success")
      await load()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to delete credential", "error")
    } finally {
      setDeletingBusy(false)
    }
  }

  if (loading) return <PageSkeleton columns={2} rows={5} />

  return (
    <PageLayout title="BYOK Credentials" icon={Cloud} actions={<><Button variant="outline" size="sm" onClick={() => { setRefreshing(true); void load() }} disabled={refreshing}><RefreshCw className={refreshing ? "animate-spin" : ""} />Refresh</Button><Button size="sm" onClick={() => { clearEditor(); setDialogOpen(true) }}><Plus />Add credential</Button></>}>
      <Card className="mb-5 border-info-muted bg-info-muted/20"><CardContent className="flex items-start gap-3 px-5 py-4 text-sm"><Cloud className="mt-0.5 size-4 shrink-0 text-info-fg" /><p className="text-muted-foreground">Credentials are encrypted for this workspace. The plaintext is used only during submission and validation; it is never returned, logged, or stored in browser state after this page action.</p></CardContent></Card>
      {credentials.length === 0 ? <Card><EmptyState icon={Cloud} title="No BYOK credential" description="Add a Firecrawl Cloud credential if you want to use your own provider funding, including while waiting for included access." action={{ label: "Add credential", onClick: () => { clearEditor(); setDialogOpen(true) } }} /></Card> : <div className="grid gap-4 lg:grid-cols-2">{credentials.map((credential) => <Card key={credential.id}><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-sm"><Cloud className="size-4 text-info-fg" />Firecrawl Cloud</CardTitle><CardDescription className="mt-1 font-mono text-xs">{credential.masked_prefix}••••{credential.masked_suffix}</CardDescription></div><Badge variant={credential.status === "valid" ? "success" : credential.status === "invalid" ? "destructive" : "warning"}>{credential.status}</Badge></div></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 text-sm sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Last validation</p><p className="mt-1">{formatDate(credential.last_validated_at)}</p></div><div><p className="text-xs text-muted-foreground">Last used</p><p className="mt-1">{formatDate(credential.last_used_at)}</p></div></div>{credential.status === "valid" ? <p className="flex items-center gap-2 text-xs text-success-fg"><CheckCircle2 className="size-4" />Provider connection is healthy.</p> : <p className="flex items-center gap-2 text-xs text-warning-fg"><WifiOff className="size-4" />Test the connection or replace this credential before using BYOK.</p>}<div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] pt-3"><Button variant="outline" size="sm" onClick={() => void validate(credential)}><RefreshCw />Test connection</Button><Button variant="outline" size="sm" onClick={() => { setReplacing(credential); setValue(""); setCurrentPassword(""); setMfaCode(""); setDialogOpen(true) }}><RotateCcw />Replace</Button><Button variant="outline" size="sm" className="text-danger-fg" onClick={() => remove(credential)}><Trash2 />Delete</Button></div></CardContent></Card>)}</div>}
      <Dialog open={dialogOpen} title={replacing ? "Replace BYOK credential" : "Add BYOK credential"} description="The provider value is sent over the protected connection and will not be displayed again. Reauthentication is required." onClose={() => { if (!saving) { setDialogOpen(false); clearEditor() } }} footer={<><Button variant="outline" size="sm" onClick={() => { setDialogOpen(false); clearEditor() }}>Cancel</Button><Button type="submit" form="credential-form" size="sm" disabled={saving || !value.trim() || !currentPassword}>{saving && <Loader2 className="animate-spin" />}{saving ? "Validating..." : replacing ? "Replace credential" : "Add credential"}</Button></>}><form id="credential-form" onSubmit={save} className="space-y-3"><label className="block text-sm font-medium" htmlFor="provider-credential">Firecrawl Cloud API key<Input id="provider-credential" className="mt-2 font-mono" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" required /></label><label className="block text-sm font-medium" htmlFor="credential-current-password">Current password<Input id="credential-current-password" className="mt-2" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label className="block text-sm font-medium" htmlFor="credential-mfa">Authenticator or recovery code<Input id="credential-mfa" className="mt-2" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} autoComplete="one-time-code" /></label><p className="text-xs text-muted-foreground">Validation is bounded and provider errors never echo the submitted value.</p></form></Dialog>
      <Dialog open={Boolean(validating)} title="Test BYOK connection" description="Confirm your current credentials before contacting the provider." onClose={() => { if (!validatingBusy) setValidating(null) }} footer={<><Button variant="outline" size="sm" onClick={() => setValidating(null)} disabled={validatingBusy}>Cancel</Button><Button type="submit" form="validate-credential-form" size="sm" disabled={validatingBusy || !validationPassword}>{validatingBusy ? "Testing..." : "Test connection"}</Button></>}><form id="validate-credential-form" onSubmit={submitValidation} className="space-y-3"><p className="text-sm text-muted-foreground">{validating?.masked_prefix}••••{validating?.masked_suffix}</p><label className="block text-sm font-medium" htmlFor="validate-credential-password">Current password<Input id="validate-credential-password" className="mt-2" type="password" value={validationPassword} onChange={(event) => setValidationPassword(event.target.value)} autoComplete="current-password" required /></label><label className="block text-sm font-medium" htmlFor="validate-credential-mfa">Authenticator or recovery code<Input id="validate-credential-mfa" className="mt-2" value={validationMfa} onChange={(event) => setValidationMfa(event.target.value)} autoComplete="one-time-code" /></label></form></Dialog>
      <Dialog open={Boolean(deleting)} title="Delete BYOK credential" description="Confirm your current credentials to revoke this provider credential." onClose={() => { if (!deletingBusy) setDeleting(null) }} footer={<><Button variant="outline" size="sm" onClick={() => setDeleting(null)} disabled={deletingBusy}>Cancel</Button><Button variant="destructive" type="submit" form="delete-credential-form" size="sm" disabled={deletingBusy || !deletionPassword}><Trash2 />{deletingBusy ? "Deleting..." : "Delete credential"}</Button></>}><form id="delete-credential-form" onSubmit={submitDeletion} className="space-y-3"><p className="text-sm text-muted-foreground">{deleting?.masked_prefix}••••{deleting?.masked_suffix}</p><label className="block text-sm font-medium" htmlFor="delete-credential-password">Current password<Input id="delete-credential-password" className="mt-2" type="password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} autoComplete="current-password" required /></label><label className="block text-sm font-medium" htmlFor="delete-credential-mfa">Authenticator or recovery code<Input id="delete-credential-mfa" className="mt-2" value={deletionMfa} onChange={(event) => setDeletionMfa(event.target.value)} autoComplete="one-time-code" /></label></form></Dialog>
      {dialog}
    </PageLayout>
  )
}
