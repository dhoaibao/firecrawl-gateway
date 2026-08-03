import { useEffect, useState } from "react"
import { Link } from "react-router"
import { AlertCircle, CheckCircle2, Loader2, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { publicPost, API_BASE } from "@/lib/api"

export default function Register() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [consent, setConsent] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => { document.title = "Create an account — Firecrawl Gateway" }, [])

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    if (password !== confirmation) {
      setError("Passwords do not match.")
      return
    }
    if (!consent) {
      setError("Please accept the account terms to continue.")
      return
    }
    setSubmitting(true)
    try {
      await publicPost(`${API_BASE}/auth/register`, { name, email, password })
      setComplete(true)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to complete registration.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <section className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-surface-2/80 p-8 shadow-[var(--shadow-modal)] backdrop-blur-xl" aria-labelledby="register-title">
        <div className="mb-7 text-center"><div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-surface-3"><Shield className="size-7" /></div><h1 id="register-title" className="text-xl font-semibold">Create your workspace</h1><p className="mt-2 text-sm text-muted-foreground">Start with a personal Firecrawl Gateway endpoint.</p></div>
        {complete ? (
          <div className="space-y-5 text-center"><CheckCircle2 className="mx-auto size-10 text-success-fg" /><div><h2 className="font-semibold">Check your email</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">If this registration can be processed, we sent instructions to verify the email address. Your account will show its available tier after verification.</p></div><Button asChild className="w-full"><Link to="/login">Continue to sign in</Link></Button></div>
        ) : (
          <form onSubmit={submit} className="space-y-4" aria-label="Create an account">
            {error && <div className="flex gap-2 rounded-lg border border-danger-muted bg-danger-muted/40 px-3 py-2.5 text-sm text-danger-fg" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
            <label className="block text-sm font-medium" htmlFor="register-name">Name<Input id="register-name" className="mt-2 h-11 bg-surface-1" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label>
            <label className="block text-sm font-medium" htmlFor="register-email">Email<Input id="register-email" className="mt-2 h-11 bg-surface-1" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
            <label className="block text-sm font-medium" htmlFor="register-password">Password<Input id="register-password" className="mt-2 h-11 bg-surface-1" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label>
            <p className="-mt-2 text-xs text-muted-foreground">Use at least 12 characters. Passphrases and all character types are supported.</p>
            <label className="block text-sm font-medium" htmlFor="register-confirmation">Confirm password<Input id="register-confirmation" className="mt-2 h-11 bg-surface-1" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label>
            <label className="flex items-start gap-2.5 text-sm text-muted-foreground"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 accent-info" required /> <span>I agree to the account terms and privacy notice.</span></label>
            <Button type="submit" className="h-11 w-full" disabled={submitting}>{submitting && <Loader2 className="animate-spin" />}Create account</Button>
          </form>
        )}
        <p className="mt-6 text-center text-sm text-muted-foreground">Already have an account? <Link to="/login" className="text-info-fg hover:underline">Sign in</Link></p>
      </section>
    </main>
  )
}
