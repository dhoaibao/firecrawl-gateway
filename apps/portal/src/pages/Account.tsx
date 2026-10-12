import { useEffect } from "react";
import { UserRound } from "lucide-react";
import { Badge } from "@firecrawl-gateway/ui/components/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useResource } from "@/hooks/useResource";
import { formatDate, PROVIDER_LABELS } from "@/lib/format";
import type { Identity, PortalUser, ProviderName } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { ProviderButtons } from "@/components/ProviderButtons";
import { LoadError, LoadingRows } from "@/components/StateViews";

export default function Account() {
  const { user } = useAuth();
  const account = useResource<{ user: PortalUser; identities: Identity[] }>("/portal/api/account");
  const providers = useResource<{ providers: ProviderName[] }>("/portal/api/auth/providers");

  useEffect(() => {
    document.title = "Account — Firecrawl Gateway";
  }, []);

  const linked = new Set((account.data?.identities ?? []).map((identity) => identity.provider));
  const unlinked = (providers.data?.providers ?? []).filter((provider) => !linked.has(provider));

  return (
    <>
      <PageHeader title="Account" description="How you sign in to the gateway portal." />

      <section className="mb-6 flex items-center gap-4 rounded-xl border border-white/[0.06] bg-surface-2 p-4">
        {user?.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="size-12 rounded-full border border-white/[0.08]"
          />
        ) : (
          <div className="flex size-12 items-center justify-center rounded-full border border-white/[0.08] bg-surface-3 text-muted-foreground">
            <UserRound className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user?.name || user?.email}</p>
          <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
        </div>
      </section>

      <section aria-labelledby="signin-methods">
        <h2 id="signin-methods" className="mb-3 text-sm font-semibold">
          Sign-in methods
        </h2>
        {account.loading && !account.data ? (
          <LoadingRows rows={2} />
        ) : account.error ? (
          <LoadError message={account.error} onRetry={account.reload} />
        ) : (
          <ul className="space-y-2">
            {(account.data?.identities ?? []).map((identity) => (
              <li
                key={identity.provider}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-surface-2 px-4 py-3"
              >
                <span className="text-sm font-medium">
                  {PROVIDER_LABELS[identity.provider] ?? identity.provider}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {identity.email}
                </span>
                <Badge variant="success">Linked {formatDate(identity.linked_at)}</Badge>
              </li>
            ))}
          </ul>
        )}

        {unlinked.length > 0 && (
          <div className="mt-6 max-w-sm">
            <h3 className="mb-1 text-sm font-semibold">Add another way to sign in</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Linking happens while you are signed in, so a different sign-in is never merged into
              your account by email alone.
            </p>
            <ProviderButtons providers={unlinked} link />
          </div>
        )}
      </section>
    </>
  );
}
