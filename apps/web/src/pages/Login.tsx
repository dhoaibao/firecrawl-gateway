import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AlertCircle, Eye, EyeOff, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";

function safeDestination(value: string | null): string {
  return value && (value.startsWith("/app") || value.startsWith("/admin")) ? value : "/app";
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shake, setShake] = useState(false);
  const { login, completeMfa } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const destination = safeDestination(searchParams.get("next"));

  useEffect(() => { document.title = "Sign in — Firecrawl Gateway" }, []);

  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setShake(false);
    setSubmitting(true);
    try {
      if (mfaRequired) {
        await completeMfa(mfaCode, recoveryMode);
      } else {
        const authenticated = await login(email, password);
        if (!authenticated) {
          setMfaRequired(true);
          return;
        }
      }
      navigate(destination, { replace: true });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to sign in. Check your details and try again.");
      setShake(true);
      window.setTimeout(() => setShake(false), 500);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden"><div className="absolute -left-20 -top-20 size-[500px] rounded-full bg-info/8 blur-[100px] animate-pulse-soft" /><div className="absolute -right-20 top-1/3 size-[400px] rounded-full bg-success/6 blur-[80px] animate-pulse-soft" /></div>
      <section className={`relative w-full max-w-sm animate-slide-up ${shake ? "animate-shake" : ""}`} aria-labelledby="login-title">
        <div className="absolute -inset-px rounded-2xl bg-gradient-to-b from-white/10 via-white/5 to-transparent opacity-60 blur-sm" />
        <div className="relative rounded-2xl border border-white/[0.08] bg-surface-2/80 p-8 shadow-[var(--shadow-modal)] backdrop-blur-xl">
          <div className="mb-8 flex flex-col items-center gap-4">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-surface-3"><Shield className="size-7 text-foreground" /></div>
            <div className="text-center"><h1 id="login-title" className="text-xl font-semibold text-foreground">Firecrawl Gateway</h1><p className="mt-1 text-sm text-muted-foreground">Sign in to your workspace</p></div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5" aria-label="Sign in">
            {error && <div className="flex items-center gap-2 rounded-lg border border-danger-muted bg-danger-muted/50 px-3 py-2.5 text-sm text-danger-fg" role="alert"><AlertCircle className="size-4 shrink-0" />{error}</div>}
            {!mfaRequired && <>
              <label className="block text-sm font-medium text-foreground" htmlFor="email">Email<Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" className="mt-2 h-11 bg-surface-1 px-4" placeholder="you@example.com" /></label>
              <label className="block text-sm font-medium text-foreground" htmlFor="password">Password
                <span className="relative mt-2 block"><Input id="password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" className="h-11 bg-surface-1 px-4 pr-11" placeholder="Your password" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></span>
              </label>
              <div className="flex justify-end"><Link to="/forgot-password" className="text-xs text-info-fg underline-offset-4 hover:underline">Forgot password?</Link></div>
            </>}
            {mfaRequired && <>
              <div className="rounded-lg border border-info-muted bg-info-muted/30 px-3 py-2.5 text-sm text-info-fg">Additional verification is required to finish signing in.</div>
              <label className="block text-sm font-medium text-foreground" htmlFor="mfa-code">{recoveryMode ? "Recovery code" : "Authenticator code"}<Input id="mfa-code" inputMode={recoveryMode ? "text" : "numeric"} autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} required className="mt-2 h-11 bg-surface-1 px-4" placeholder={recoveryMode ? "xxxx-xxxx" : "123456"} /></label>
              <button type="button" className="text-left text-xs text-info-fg underline-offset-4 hover:underline" onClick={() => { setRecoveryMode((value) => !value); setMfaCode(""); }}>{recoveryMode ? "Use an authenticator code" : "Use a recovery code instead"}</button>
            </>}
            <Button type="submit" disabled={submitting} className="h-11 w-full">{submitting ? "Signing in..." : "Sign in"}</Button>
          </form>
          <p className="mt-6 text-center text-sm text-muted-foreground">New here? <Link to="/register" className="text-info-fg underline-offset-4 hover:underline">Create an account</Link></p>
        </div>
      </section>
    </main>
  );
}
