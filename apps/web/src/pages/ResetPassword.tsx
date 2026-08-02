import { useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { AlertCircle, KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { publicPost, API_BASE } from "@/lib/api"

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [token] = useState(() => searchParams.get("token"))
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [error, setError] = useState("")
  const [complete, setComplete] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    document.title = "Reset password — Firecrawl Gateway"
    if (token) navigate("/reset-password", { replace: true })
  }, [navigate, token])

  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) {
      setError("This reset link is invalid or incomplete.")
      return
    }
    if (password !== confirmation) {
      setError("Passwords do not match.")
      return
    }
    setError("")
    setSaving(true)
    try {
      await publicPost(`${API_BASE}/auth/password/reset`, { token, new_password: password })
      setComplete(true)
      setPassword("")
      setConfirmation("")
    } catch {
      setError("This reset link is invalid or expired. Request a new one if needed.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-surface-2/80 p-8 shadow-[var(--shadow-modal)] backdrop-blur-xl">
        <div className="mb-6 text-center"><div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-surface-3"><KeyRound className="size-6 text-info-fg" /></div><h1 className="text-xl font-semibold">{complete ? "Password reset" : "Set a new password"}</h1><p className="mt-2 text-sm text-muted-foreground">{complete ? "Your password has been updated. Sign in with your new password." : "Choose a unique password with at least 12 characters."}</p></div>
        {complete ? <Button asChild className="w-full"><Link to="/login">Go to sign in</Link></Button> : <form onSubmit={handleSubmit} className="space-y-5">{error && <p className="flex items-center gap-2 rounded-lg border border-danger-muted bg-danger-muted/50 px-3 py-2.5 text-sm text-danger-fg" role="alert"><AlertCircle className="size-4 shrink-0" />{error}</p>}<label className="block text-sm font-medium">New password<Input className="mt-2 h-11 bg-surface-1 px-4" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label><label className="block text-sm font-medium">Confirm new password<Input className="mt-2 h-11 bg-surface-1 px-4" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label><Button type="submit" className="w-full" disabled={saving || !token}>{saving && <Loader2 className="animate-spin" />}Reset password</Button></form>}
      </section>
    </main>
  )
}
