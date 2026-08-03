import { useEffect, useState } from "react"
import { Link } from "react-router"
import { CheckCircle2, Loader2, Mail, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { publicPost, API_BASE } from "@/lib/api"

export default function ForgotPassword() {
  const [email, setEmail] = useState("")
  const [complete, setComplete] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => { document.title = "Recover access — Firecrawl Gateway" }, [])

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    try {
      await publicPost(`${API_BASE}/auth/password/forgot`, { email })
    } catch {
      // Keep the response generic for transport and account-state failures.
    } finally {
      // A generic completion state prevents account enumeration even on API errors.
      setComplete(true)
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-surface-2/80 p-8 shadow-[var(--shadow-modal)] backdrop-blur-xl" aria-labelledby="forgot-title">
        <div className="mb-7 text-center"><div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-surface-3"><Shield className="size-7" /></div><h1 id="forgot-title" className="text-xl font-semibold">Recover access</h1><p className="mt-2 text-sm text-muted-foreground">We will send next steps without revealing account status.</p></div>
        {complete ? <div className="space-y-5 text-center"><CheckCircle2 className="mx-auto size-10 text-success-fg" /><p className="text-sm leading-relaxed text-muted-foreground">If an account can be processed, an email with recovery instructions is on its way.</p><Button asChild className="w-full"><Link to="/login">Return to sign in</Link></Button></div> : <form onSubmit={submit} className="space-y-5"><label className="block text-sm font-medium" htmlFor="forgot-email">Email address<Input id="forgot-email" className="mt-2 h-11 bg-surface-1" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><Button type="submit" className="h-11 w-full" disabled={submitting}>{submitting ? <Loader2 className="animate-spin" /> : <Mail />}Send recovery email</Button></form>}
        <p className="mt-6 text-center text-sm text-muted-foreground"><Link to="/login" className="text-info-fg hover:underline">Back to sign in</Link></p>
      </section>
    </main>
  )
}
