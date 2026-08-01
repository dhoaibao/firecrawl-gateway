import { useEffect, useState } from "react"
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, Smartphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import PageLayout from "@/components/PageLayout"
import { useToast } from "@/hooks/useToast"
import { api } from "@/lib/api"

export default function Account() {
  const { addToast } = useToast()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [saving, setSaving] = useState(false)
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [mfaCode, setMfaCode] = useState("")
  const [passwordMfaCode, setPasswordMfaCode] = useState("")
  const [mfaCurrentPassword, setMfaCurrentPassword] = useState("")
  const [mfaExistingCode, setMfaExistingCode] = useState("")
  const [mfaRecoveryCode, setMfaRecoveryCode] = useState("")
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [mfaSaving, setMfaSaving] = useState(false)

  useEffect(() => {
    document.title = "Account — Firecrawl Gateway"
    void api.get<{ data: { enabled: boolean } }>("/admin/api/auth/mfa")
      .then((result) => setMfaEnabled(result.data.enabled))
      .catch(() => setMfaEnabled(false))
  }, [])

  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (newPassword !== confirmPassword) {
      addToast("New passwords do not match", "error")
      return
    }

    setSaving(true)
    try {
      await api.post("/admin/api/auth/password", {
        current_password: currentPassword,
        new_password: newPassword,
        mfa_code: passwordMfaCode,
      })
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      setPasswordMfaCode("")
      addToast("Password changed successfully", "success")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Failed to change password", "error")
    } finally {
      setSaving(false)
    }
  }

  async function beginMfaSetup() {
    setMfaSaving(true)
    try {
      const result = await api.post<{ data: { secret: string; uri: string } }>("/admin/api/auth/mfa/setup", {
        current_password: mfaCurrentPassword,
        mfa_code: mfaExistingCode,
        recovery_code: mfaRecoveryCode,
      })
      setMfaSetup(result.data)
      setMfaCode("")
      setMfaCurrentPassword("")
      setMfaExistingCode("")
      setMfaRecoveryCode("")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Failed to start MFA setup", "error")
    } finally {
      setMfaSaving(false)
    }
  }

  async function enableMfa() {
    if (!mfaCode.trim()) {
      addToast("Enter the code from your authenticator app", "error")
      return
    }
    setMfaSaving(true)
    try {
      const result = await api.post<{ recovery_codes: string[] }>("/admin/api/auth/mfa/enable", { code: mfaCode })
      setRecoveryCodes(result.recovery_codes)
      setMfaSetup(null)
      setMfaCode("")
      setMfaEnabled(true)
      addToast("Multi-factor authentication enabled", "success")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to verify authentication code", "error")
    } finally {
      setMfaSaving(false)
    }
  }

  async function disableMfa() {
    setMfaSaving(true)
    try {
      await api.post("/admin/api/auth/mfa/disable", {
        current_password: mfaCurrentPassword,
        mfa_code: mfaExistingCode,
        recovery_code: mfaRecoveryCode,
      })
      setMfaEnabled(false)
      setMfaCurrentPassword("")
      setMfaExistingCode("")
      setMfaRecoveryCode("")
      addToast("Multi-factor authentication disabled", "success")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to disable MFA", "error")
    } finally {
      setMfaSaving(false)
    }
  }

  const inputClassName = "mt-2 h-10 w-full rounded-lg border border-white/[0.08] bg-surface-3 px-3 text-sm text-foreground outline-none transition-all placeholder:text-muted-foreground hover:border-white/12 focus:border-ring focus:ring-2 focus:ring-ring/30"

  return (
    <PageLayout
      title="Account"
      icon={KeyRound}
    >
      <div className="grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <Card className="overflow-hidden border-white/[0.06] bg-surface-2 py-0">
          <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-5">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border border-info-muted bg-info-muted/40 p-2 text-info-fg">
                <KeyRound className="size-4" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">Change password</CardTitle>
                <CardDescription className="mt-1.5">Use a unique password with at least 12 characters.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-5 py-5">
            <form className="space-y-5" onSubmit={handleSubmit}>
              <label className="block text-sm font-medium text-foreground">
                Current password
                <Input className={inputClassName} type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required autoComplete="current-password" />
              </label>
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="block text-sm font-medium text-foreground">
                  New password
                  <Input className={inputClassName} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" />
                </label>
                <label className="block text-sm font-medium text-foreground">
                  Confirm new password
                  <Input className={inputClassName} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" />
                </label>
              </div>
              <label className="block text-sm font-medium text-foreground">
                Authenticator code <span className="font-normal text-muted-foreground">(required when MFA is enabled)</span>
                <Input className={inputClassName} inputMode="numeric" autoComplete="one-time-code" value={passwordMfaCode} onChange={(event) => setPasswordMfaCode(event.target.value)} placeholder="123456" />
              </label>
              <div className="flex justify-end border-t border-white/[0.06] pt-5">
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="animate-spin" />}
                  Change password
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-white/[0.06] bg-surface-2">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Smartphone className="size-4 text-info-fg" />
                <CardTitle className="text-sm font-semibold">Authenticator app</CardTitle>
              </div>
              <CardDescription>Use a time-based code to protect operator actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {recoveryCodes ? (
                <>
                  <p className="text-sm text-warning-fg">Store these recovery codes offline. They will not be shown again.</p>
                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-3 p-3 font-mono text-xs text-foreground">
                    {recoveryCodes.map((code) => <span key={code}>{code}</span>)}
                  </div>
                  <Button variant="outline" className="w-full" onClick={() => setRecoveryCodes(null)}>I stored my recovery codes</Button>
                </>
              ) : mfaSetup ? (
                <>
                  <p className="text-sm text-muted-foreground">Add this setup key to your authenticator app, then enter its current code.</p>
                  <Input className="font-mono text-xs" value={mfaSetup.secret} readOnly aria-label="Authenticator setup key" />
                  <a className="block text-sm text-info-fg underline underline-offset-4" href={mfaSetup.uri}>Open authenticator app</a>
                  <label className="block text-sm font-medium text-foreground">Authenticator code
                    <Input className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} required placeholder="123456" />
                  </label>
                  <Button className="w-full" onClick={enableMfa} disabled={mfaSaving}>{mfaSaving && <Loader2 className="animate-spin" />}Enable MFA</Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{mfaEnabled ? "To replace or disable your authenticator, provide your current password and either a current code or recovery code." : "Leave these fields blank for first-time setup."}</p>
                  <label className="block text-sm font-medium text-foreground">Current password
                    <Input className="mt-2" type="password" value={mfaCurrentPassword} onChange={(event) => setMfaCurrentPassword(event.target.value)} autoComplete="current-password" />
                  </label>
                  <label className="block text-sm font-medium text-foreground">Current authenticator code
                    <Input className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={mfaExistingCode} onChange={(event) => setMfaExistingCode(event.target.value)} placeholder="123456" />
                  </label>
                  <label className="block text-sm font-medium text-foreground">Recovery code instead
                    <Input className="mt-2 font-mono" value={mfaRecoveryCode} onChange={(event) => setMfaRecoveryCode(event.target.value)} autoComplete="one-time-code" />
                  </label>
                  <Button className="w-full" onClick={beginMfaSetup} disabled={mfaSaving}>{mfaSaving && <Loader2 className="animate-spin" />}{mfaEnabled ? "Replace authenticator app" : "Set up authenticator app"}</Button>
                  {mfaEnabled && <Button variant="outline" className="w-full text-danger-fg hover:text-danger-fg" onClick={disableMfa} disabled={mfaSaving}>Disable MFA</Button>}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-white/[0.06] bg-surface-2 shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success-fg" />
              <CardTitle className="text-sm font-semibold">Security checklist</CardTitle>
            </div>
            <CardDescription>Keep your administrator account protected.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {["Use a password you do not reuse elsewhere", "Keep your password private", "Change it immediately if you suspect exposure"].map((item) => (
              <div key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-fg" />
                <span>{item}</span>
              </div>
            ))}
          </CardContent>
          </Card>
        </div>
      </div>
    </PageLayout>
  )
}
