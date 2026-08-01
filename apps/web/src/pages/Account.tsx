import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { CheckCircle2, KeyRound, Loader2, Mail, ShieldCheck, Smartphone } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import PageLayout from "@/components/PageLayout"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"
import { api } from "@/lib/api"

type MfaManagementAction = "replace" | "disable" | null

export default function Account() {
  const { user, logout } = useAuth()
  const { addToast } = useToast()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordMfaCode, setPasswordMfaCode] = useState("")
  const [saving, setSaving] = useState(false)
  const [email, setEmail] = useState("")
  const [emailCurrentPassword, setEmailCurrentPassword] = useState("")
  const [emailMfaCode, setEmailMfaCode] = useState("")
  const [emailSaving, setEmailSaving] = useState(false)
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [mfaQrCode, setMfaQrCode] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState("")
  const [mfaCurrentPassword, setMfaCurrentPassword] = useState("")
  const [mfaExistingCode, setMfaExistingCode] = useState("")
  const [mfaRecoveryCode, setMfaRecoveryCode] = useState("")
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [mfaAction, setMfaAction] = useState<MfaManagementAction>(null)
  const [mfaSaving, setMfaSaving] = useState(false)

  useEffect(() => {
    document.title = "Account — Firecrawl Gateway"
    void api.get<{ data: { enabled: boolean } }>("/admin/api/auth/mfa")
      .then((mfa) => setMfaEnabled(mfa.data.enabled))
      .catch(() => setMfaEnabled(false))
  }, [])

  async function handlePasswordChange(event: React.SubmitEvent<HTMLFormElement>) {
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
      addToast("Password changed. Sign in again to continue.", "success")
      await logout()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Failed to change password", "error")
    } finally {
      setSaving(false)
    }
  }

  async function handleEmailChange(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setEmailSaving(true)
    try {
      await api.post("/admin/api/auth/email", {
        email,
        current_password: emailCurrentPassword,
        mfa_code: emailMfaCode,
      })
      setEmail("")
      setEmailCurrentPassword("")
      setEmailMfaCode("")
      addToast("Check the new address to confirm this change.", "success")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to request an email change", "error")
    } finally {
      setEmailSaving(false)
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
      setMfaQrCode(await QRCode.toDataURL(result.data.uri, { width: 240, margin: 1, errorCorrectionLevel: "M" }))
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
      setMfaQrCode(null)
      setMfaCode("")
      setMfaEnabled(true)
      setMfaAction(null)
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
      setMfaAction(null)
      setMfaCurrentPassword("")
      setMfaExistingCode("")
      setMfaRecoveryCode("")
      addToast("Multi-factor authentication disabled. Sign in again to continue.", "success")
      await logout()
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to disable MFA", "error")
    } finally {
      setMfaSaving(false)
    }
  }

  const inputClassName = "mt-2 h-10 w-full rounded-lg border border-white/[0.08] bg-surface-3 px-3 text-sm text-foreground outline-none transition-all placeholder:text-muted-foreground hover:border-white/12 focus:border-ring focus:ring-2 focus:ring-ring/30"

  return (
    <PageLayout title="Account" icon={KeyRound}>
      <div className="w-full space-y-4">
        <Card className="overflow-hidden border-white/[0.06] bg-surface-2 py-0">
          <CardContent className="grid gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-info-muted bg-info-muted/40 text-lg font-semibold text-info-fg">
                {(user?.name || user?.email || "A").slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-foreground">{user?.name || "Your account"}</p>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{user?.email}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="success"><CheckCircle2 className="size-3" />Email verified</Badge>
              <Badge variant={mfaEnabled ? "success" : "warning"}><ShieldCheck className="size-3" />{mfaEnabled ? "MFA enabled" : "MFA required"}</Badge>
              {user?.is_admin && <Badge variant="info">Administrator</Badge>}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-12">
          <div className="space-y-4 xl:col-span-7">
            <Card className="border-white/[0.06] bg-surface-2">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Mail className="size-4 text-info-fg" />
                  <CardTitle className="text-sm font-semibold">Email address</CardTitle>
                </div>
                <CardDescription>Confirmation is required before your sign-in email changes.</CardDescription>
              </CardHeader>
              <CardContent>
                <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleEmailChange}>
                  <label className="block text-sm font-medium text-foreground sm:col-span-2">New email address
                    <Input className={inputClassName} type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" placeholder={user?.email} />
                  </label>
                  <label className="block text-sm font-medium text-foreground">Current password
                    <Input className={inputClassName} type="password" value={emailCurrentPassword} onChange={(event) => setEmailCurrentPassword(event.target.value)} required autoComplete="current-password" />
                  </label>
                  <label className="block text-sm font-medium text-foreground">Authenticator code <span className="font-normal text-muted-foreground">{mfaEnabled ? "(required)" : "(if enabled)"}</span>
                    <Input className={inputClassName} inputMode="numeric" autoComplete="one-time-code" value={emailMfaCode} onChange={(event) => setEmailMfaCode(event.target.value)} placeholder="123456" />
                  </label>
                  <div className="flex justify-end border-t border-white/[0.06] pt-4 sm:col-span-2">
                    <Button type="submit" disabled={emailSaving}>{emailSaving && <Loader2 className="animate-spin" />}Send confirmation email</Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-white/[0.06] bg-surface-2 py-0">
              <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg border border-info-muted bg-info-muted/40 p-2 text-info-fg"><KeyRound className="size-4" /></div>
                  <div>
                    <CardTitle className="text-sm font-semibold">Change password</CardTitle>
                    <CardDescription className="mt-1.5">Use a unique password with at least 12 characters.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-5 py-5">
                <form className="space-y-5" onSubmit={handlePasswordChange}>
                  <label className="block text-sm font-medium text-foreground">Current password
                    <Input className={inputClassName} type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required autoComplete="current-password" />
                  </label>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <label className="block text-sm font-medium text-foreground">New password
                      <Input className={inputClassName} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" />
                    </label>
                    <label className="block text-sm font-medium text-foreground">Confirm new password
                      <Input className={inputClassName} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" />
                    </label>
                  </div>
                  <label className="block text-sm font-medium text-foreground">Authenticator code <span className="font-normal text-muted-foreground">(required when MFA is enabled)</span>
                    <Input className={inputClassName} inputMode="numeric" autoComplete="one-time-code" value={passwordMfaCode} onChange={(event) => setPasswordMfaCode(event.target.value)} placeholder="123456" />
                  </label>
                  <div className="flex justify-end border-t border-white/[0.06] pt-5">
                    <Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin" />}Change password</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4 xl:col-span-5">
            <Card className="border-white/[0.06] bg-surface-2">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2"><Smartphone className="size-4 text-info-fg" /><CardTitle className="text-sm font-semibold">Authenticator app</CardTitle></div>
                  <Badge variant={mfaEnabled ? "success" : "warning"}>{mfaEnabled ? "Protected" : "Action required"}</Badge>
                </div>
                <CardDescription>Time-based codes are required for administrator actions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {recoveryCodes ? (
                  <>
                    <p className="text-sm text-warning-fg">Store these recovery codes offline. They will not be shown again.</p>
                    <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-3 p-3 font-mono text-xs text-foreground">{recoveryCodes.map((code) => <span key={code}>{code}</span>)}</div>
                    <Button variant="outline" className="w-full" onClick={() => setRecoveryCodes(null)}>I stored my recovery codes</Button>
                  </>
                ) : mfaSetup ? (
                  <>
                    <p className="text-sm text-muted-foreground">Scan this QR code or add the setup key to your authenticator app, then enter its current code.</p>
                    {mfaQrCode && <img src={mfaQrCode} alt="Authenticator app setup QR code" width={240} height={240} className="mx-auto rounded-lg bg-white p-2" />}
                    <Input className="font-mono text-xs" value={mfaSetup.secret} readOnly aria-label="Authenticator setup key" />
                    <a className="block text-sm text-info-fg underline underline-offset-4" href={mfaSetup.uri}>Open authenticator app</a>
                    <label className="block text-sm font-medium text-foreground">Authenticator code
                      <Input className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} required placeholder="123456" />
                    </label>
                    <Button className="w-full" onClick={enableMfa} disabled={mfaSaving}>{mfaSaving && <Loader2 className="animate-spin" />}Enable MFA</Button>
                  </>
                ) : mfaEnabled && !mfaAction ? (
                  <>
                    <p className="text-sm text-muted-foreground">Your authenticator app is protecting administrator actions.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Button variant="outline" onClick={() => setMfaAction("replace")}>Replace authenticator app</Button>
                      <Button variant="outline" className="text-danger-fg hover:text-danger-fg" onClick={() => setMfaAction("disable")}>Disable MFA</Button>
                    </div>
                  </>
                ) : mfaEnabled ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-foreground">{mfaAction === "replace" ? "Replace authenticator app" : "Disable multi-factor authentication"}</p>
                      <Button variant="ghost" size="sm" onClick={() => setMfaAction(null)}>Cancel</Button>
                    </div>
                    <p className="text-sm text-muted-foreground">Verify your current account access before continuing.</p>
                    <label className="block text-sm font-medium text-foreground">Current password
                      <Input className="mt-2" type="password" value={mfaCurrentPassword} onChange={(event) => setMfaCurrentPassword(event.target.value)} autoComplete="current-password" />
                    </label>
                    <label className="block text-sm font-medium text-foreground">Current authenticator code
                      <Input className="mt-2" inputMode="numeric" autoComplete="one-time-code" value={mfaExistingCode} onChange={(event) => setMfaExistingCode(event.target.value)} placeholder="123456" />
                    </label>
                    <label className="block text-sm font-medium text-foreground">Recovery code instead
                      <Input className="mt-2 font-mono" value={mfaRecoveryCode} onChange={(event) => setMfaRecoveryCode(event.target.value)} autoComplete="one-time-code" />
                    </label>
                    <Button className="w-full" variant={mfaAction === "disable" ? "destructive" : "default"} onClick={mfaAction === "replace" ? beginMfaSetup : disableMfa} disabled={mfaSaving}>{mfaSaving && <Loader2 className="animate-spin" />}{mfaAction === "replace" ? "Continue to replacement" : "Disable MFA"}</Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">Set up an authenticator app to protect administrator actions.</p>
                    <Button className="w-full" onClick={beginMfaSetup} disabled={mfaSaving}>{mfaSaving && <Loader2 className="animate-spin" />}Set up authenticator app</Button>
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="border-white/[0.06] bg-surface-2 shadow-none">
              <CardHeader>
                <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-success-fg" /><CardTitle className="text-sm font-semibold">Security posture</CardTitle></div>
                <CardDescription>Review these controls regularly to keep your account protected.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-surface-3 p-3 text-sm text-muted-foreground"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-fg" /><span>Your email address is verified.</span></div>
                <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-surface-3 p-3 text-sm text-muted-foreground"><ShieldCheck className={`mt-0.5 size-4 shrink-0 ${mfaEnabled ? "text-success-fg" : "text-warning-fg"}`} /><span>{mfaEnabled ? "Your administrator MFA is enabled." : "Set up MFA before accessing administrator operations."}</span></div>
              </CardContent>
            </Card>
          </div>

        </div>
      </div>
    </PageLayout>
  )
}
