import { useEffect, useState } from "react"
import { CheckCircle2, KeyRound, Loader2, ShieldCheck } from "lucide-react"
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

  useEffect(() => { document.title = "Account — Firecrawl Gateway" }, [])

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
      })
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      addToast("Password changed successfully", "success")
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Failed to change password", "error")
    } finally {
      setSaving(false)
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
                <CardDescription className="mt-1.5">Use a unique password with at least 8 characters.</CardDescription>
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
                  <Input className={inputClassName} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={8} maxLength={128} autoComplete="new-password" />
                </label>
                <label className="block text-sm font-medium text-foreground">
                  Confirm new password
                  <Input className={inputClassName} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} maxLength={128} autoComplete="new-password" />
                </label>
              </div>
              <div className="flex justify-end border-t border-white/[0.06] pt-5">
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="animate-spin" />}
                  Change password
                </Button>
              </div>
            </form>
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
    </PageLayout>
  )
}
