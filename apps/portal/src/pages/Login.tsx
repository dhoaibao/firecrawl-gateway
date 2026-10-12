import { useEffect } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useResource } from "@/hooks/useResource";
import { ProviderButtons } from "@/components/ProviderButtons";
import { LoadError } from "@/components/StateViews";
import { Skeleton } from "@firecrawl-gateway/ui/components/skeleton";
import type { ProviderName } from "@/lib/types";

/** What the API's `?error=` codes mean for the person signing in. */
const ERRORS: Record<string, string> = {
  invalid_state: "That sign-in attempt expired or was not started here. Please try again.",
  access_denied: "Sign-in was cancelled.",
  provider_error: "The provider could not complete the sign-in. Please try again.",
  email_unverified: "That account has no verified email address, so it can't be used here.",
  account_disabled: "This account has been disabled.",
  account_exists:
    "An account with this email already exists. Sign in with the method you used first, then link this one from Account.",
  identity_in_use: "That provider account is already linked to another user.",
  login_required: "Sign in first, then link another sign-in method.",
  server_error: "Something went wrong on our side. Please try again.",
};

export default function Login() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const providers = useResource<{ providers: ProviderName[] }>("/portal/api/auth/providers");
  const errorCode = params.get("error");
  const errorMessage = errorCode ? (ERRORS[errorCode] ?? ERRORS.server_error) : null;

  useEffect(() => {
    document.title = "Sign in — Firecrawl Gateway";
  }, []);

  if (!loading && user) return <Navigate to="/" replace />;

  return (
    <main
      id="content"
      className="flex min-h-screen items-center justify-center bg-background px-4 py-10"
    >
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img src="/logo.png" alt="" className="size-12 rounded-xl" />
          <div>
            <h1 className="text-xl font-semibold text-foreground">Firecrawl Gateway</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Bring your own Firecrawl key and get gateway API keys with limits and usage.
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-surface-2 p-6 shadow-[var(--shadow-card)]">
          {errorMessage && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg border border-danger-muted bg-danger-muted/50 px-3 py-2.5 text-sm text-danger-fg"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {errorMessage}
            </div>
          )}

          {providers.loading ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading sign-in options">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : providers.error ? (
            <LoadError message={providers.error} onRetry={providers.reload} />
          ) : providers.data && providers.data.providers.length > 0 ? (
            <ProviderButtons providers={providers.data.providers} />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Sign-in is not available right now.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
