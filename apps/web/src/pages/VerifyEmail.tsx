import { useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { AlertCircle, CheckCircle2, Loader2, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { publicPost, API_BASE } from "@/lib/api"

export default function VerifyEmail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [token] = useState(() => searchParams.get("token"))
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading")
  const [resendEmail, setResendEmail] = useState("")
  const [resendSent, setResendSent] = useState(false)
  const [resending, setResending] = useState(false)

  useEffect(() => {
    document.title = "Verify email — Firecrawl Gateway"
    // Remove the one-time value from the address bar before the request starts.
    if (token) navigate("/verify-email", { replace: true })
    if (!token) {
      setStatus("error")
      return
    }
    void publicPost(`${API_BASE}/auth/verification/consume`, { token })
      .then(() => setStatus("success"))
      .catch(() => setStatus("error"))
  }, [navigate, token])

  async function resend(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setResending(true)
    try {
      await publicPost(`${API_BASE}/auth/verification/request`, { email: resendEmail })
    } catch {
      // Keep the response generic for unknown and known accounts alike.
    } finally {
      setResendSent(true)
      setResending(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <section className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-surface-2/80 p-8 text-center shadow-[var(--shadow-modal)]">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-surface-3">{status === "loading" ? <Loader2 className="size-6 animate-spin text-info-fg" /> : status === "success" ? <CheckCircle2 className="size-7 text-success-fg" /> : <AlertCircle className="size-7 text-danger-fg" />}</div>
        <div className="mb-6"><div className="mb-2 flex items-center justify-center gap-2"><Shield className="size-4 text-muted-foreground" /><span className="text-sm font-medium text-muted-foreground">Firecrawl Gateway</span></div><h1 className="text-xl font-semibold">{status === "success" ? "Email verified" : status === "loading" ? "Verifying email" : "Unable to verify email"}</h1><p className="mt-2 text-sm text-muted-foreground">{status === "success" ? "Your email address is confirmed. You can now sign in." : status === "loading" ? "Please wait while we confirm your email address." : "This verification link is invalid or expired. Request a new one if needed."}</p></div>
        {status !== "loading" && <Button asChild className="w-full"><Link to="/login">Go to sign in</Link></Button>}
        {status === "error" && <form className="mt-5 space-y-3 text-left" onSubmit={resend}><label className="block text-sm font-medium" htmlFor="resend-email">Email address<Input id="resend-email" className="mt-2" type="email" value={resendEmail} onChange={(event) => setResendEmail(event.target.value)} autoComplete="email" required /></label><Button type="submit" variant="outline" className="w-full" disabled={resending}>{resending ? "Sending..." : resendSent ? "Email requested" : "Resend verification email"}</Button></form>}
      </section>
    </main>
  )
}
