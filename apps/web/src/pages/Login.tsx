import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, AlertCircle, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shake, setShake] = useState(false);
  const { login, completeMfa } = useAuth();

  useEffect(() => { document.title = "Sign in — Firecrawl Gateway" }, [])
  const navigate = useNavigate();

  async function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setShake(false);
    setSubmitting(true);
    try {
      if (mfaRequired) {
        await completeMfa(mfaCode);
      } else {
        const authenticated = await login(email, password);
        if (!authenticated) {
          setMfaRequired(true);
          return;
        }
      }
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 -top-20 size-[500px] rounded-full bg-info/8 blur-[100px] animate-pulse-soft"></div>
        <div className="absolute -right-20 top-1/3 size-[400px] rounded-full bg-success/6 blur-[80px] animate-pulse-soft" style={{ animationDelay: "1s" }}></div>
        <div className="absolute -bottom-20 left-1/3 size-[450px] rounded-full bg-warning/5 blur-[90px] animate-pulse-soft" style={{ animationDelay: "0.5s" }}></div>
      </div>

      <div className={`relative w-full max-w-sm animate-slide-up ${shake ? "animate-shake" : ""}`}>
        <div className="absolute -inset-[1px] rounded-2xl bg-gradient-to-b from-white/10 via-white/5 to-transparent opacity-60 blur-sm"></div>

        <div className="relative rounded-2xl border border-white/[0.08] bg-surface-2/80 p-8 shadow-[var(--shadow-modal)] backdrop-blur-xl"
        >
          <div className="mb-8 flex flex-col items-center gap-4"
          >
            <div className="relative flex size-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-gradient-to-br from-white/[0.08] to-white/[0.02] shadow-[var(--shadow-card)]"
            >
              <Shield className="size-7 text-foreground" />
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-info/10 to-transparent"></div>
            </div>
            <div className="text-center">
              <h1 className="text-xl font-semibold text-foreground">Firecrawl Gateway</h1>
              <p className="mt-1 text-sm text-muted-foreground">Sign in to your admin account</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5" aria-label="Sign in">
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-danger-muted bg-danger-muted/50 px-3 py-2.5 text-sm text-danger-fg animate-fade-in"
              role="alert"
              >
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium text-foreground">Email</label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-11 bg-surface-1 px-4"
                placeholder="admin@example.com"
              />
            </div>

            {mfaRequired && (
              <div className="space-y-1.5">
                <label htmlFor="mfa-code" className="text-sm font-medium text-foreground">Authenticator code</label>
                <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required className="h-11 bg-surface-1 px-4" placeholder="123456" />
              </div>
            )}

            {!mfaRequired && <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium text-foreground">Password</label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-11 bg-surface-1 px-4 pr-11"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>}

            <Button
              type="submit"
              disabled={submitting}
              className="h-11 w-full"
            >
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
