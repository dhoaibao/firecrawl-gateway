import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AlertCircle, CheckCircle2, Loader2, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { publicPost } from "@/lib/api"

export default function VerifyEmail() {
  const [searchParams] = useSearchParams()
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading")
  const [message, setMessage] = useState("")

  useEffect(() => {
    document.title = "Verify email — Firecrawl Gateway"
    const token = searchParams.get("token")
    if (!token) {
      setStatus("error")
      setMessage("This verification link is invalid or incomplete.")
      return
    }
    void publicPost<{ success: boolean }>("/admin/api/auth/verification/consume", { token })
      .then(() => setStatus("success"))
      .catch((error: unknown) => {
        setStatus("error")
        setMessage(error instanceof Error ? error.message : "This verification link is invalid or expired.")
      })
  }, [searchParams])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-surface-2/80 p-8 text-center shadow-[var(--shadow-modal)] backdrop-blur-xl">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-surface-3">
          {status === "loading" ? <Loader2 className="size-6 animate-spin text-info-fg" /> : status === "success" ? <CheckCircle2 className="size-7 text-success-fg" /> : <AlertCircle className="size-7 text-danger-fg" />}
        </div>
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-center gap-2"><Shield className="size-4 text-muted-foreground" /><span className="text-sm font-medium text-muted-foreground">Firecrawl Gateway</span></div>
          <h1 className="text-xl font-semibold text-foreground">{status === "success" ? "Email verified" : status === "loading" ? "Verifying email" : "Unable to verify email"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{status === "success" ? "Your email address has been confirmed. You can now sign in." : status === "loading" ? "Please wait while we confirm your email address." : message}</p>
        </div>
        {status !== "loading" && <Button asChild className="w-full"><Link to="/login">Go to sign in</Link></Button>}
      </section>
    </main>
  )
}
