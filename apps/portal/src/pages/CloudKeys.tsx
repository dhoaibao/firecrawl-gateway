import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CreditCard, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { Input } from "@firecrawl-gateway/ui/components/input";
import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { CloudKey, CloudKeyStatus } from "@/lib/types";
import { useResource } from "@/hooks/useResource";
import { useToast } from "@/contexts/ToastContext";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormDialog } from "@/components/FormDialog";
import { PageHeader } from "@/components/PageHeader";
import { EmptyBlock, LoadError, LoadingRows } from "@/components/StateViews";

interface Limits {
  limits: { max_keys: number };
}

function describeStatus(status: CloudKeyStatus): string {
  if (status.status === "invalid") return "Firecrawl rejected this key.";
  if (status.status === "unavailable") return "Could not reach Firecrawl to check this key.";
  if (status.remaining_credits === null) return "Key is valid.";
  const plan = status.plan_credits !== null ? ` of ${formatNumber(status.plan_credits)}` : "";
  return `${formatNumber(status.remaining_credits)}${plan} credits remaining.`;
}

export default function CloudKeys() {
  const { addToast } = useToast();
  const keys = useResource<CloudKey[], Limits>("/portal/api/cloud-keys");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, CloudKeyStatus>>({});
  const [removing, setRemoving] = useState<CloudKey | null>(null);

  useEffect(() => {
    document.title = "Cloud keys — Firecrawl Gateway";
  }, []);

  const list = keys.data ?? [];
  const max = keys.body?.limits.max_keys ?? null;
  const atLimit = max !== null && list.length >= max;

  function openAdd() {
    setName("");
    setSecret("");
    setFormError("");
    setAdding(true);
  }

  async function add(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError("");
    try {
      const response = await api.post<{ data: { key: CloudKey; status: CloudKeyStatus } }>(
        "/portal/api/cloud-keys",
        { name, key: secret },
      );
      setAdding(false);
      setSecret("");
      setResults((current) => ({ ...current, [response.data.key.id]: response.data.status }));
      addToast(
        `Added "${response.data.key.name}". ${describeStatus(response.data.status)}`,
        "success",
      );
      keys.reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not add the key");
    } finally {
      setSubmitting(false);
    }
  }

  async function verify(key: CloudKey) {
    setChecking(key.id);
    try {
      const response = await api.post<{ data: CloudKeyStatus }>(
        `/portal/api/cloud-keys/${encodeURIComponent(key.id)}/verify`,
        {},
      );
      setResults((current) => ({ ...current, [key.id]: response.data }));
      keys.reload();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Could not check the key");
    } finally {
      setChecking(null);
    }
  }

  async function remove(key: CloudKey) {
    setRemoving(null);
    try {
      await api.delete(`/portal/api/cloud-keys/${encodeURIComponent(key.id)}`);
      addToast(`Removed "${key.name}"`, "success");
      keys.reload();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Could not remove the key");
    }
  }

  return (
    <>
      <PageHeader
        title="Cloud keys"
        description="Your own Firecrawl Cloud API keys. Requests made with your gateway keys run on these and spend your Firecrawl credits; with several keys, requests are spread across the ones that still have credits."
        actions={
          <Button type="button" onClick={openAdd} disabled={atLimit}>
            <Plus /> Add key
          </Button>
        }
      />

      {max !== null && (
        <p className="mb-4 text-xs text-muted-foreground">
          {list.length} of {max} keys. Keys are encrypted at rest and never shown again after you
          add them.
        </p>
      )}

      {keys.loading && !keys.data ? (
        <LoadingRows />
      ) : keys.error ? (
        <LoadError message={keys.error} onRetry={keys.reload} />
      ) : list.length === 0 ? (
        <EmptyBlock
          icon={CreditCard}
          title="No Cloud keys yet"
          description="Add a Firecrawl Cloud API key. We check it with Firecrawl before saving it."
          action={{ label: "Add key", onClick: openAdd }}
        />
      ) : (
        <ul className="space-y-3">
          {list.map((key) => {
            const result = results[key.id];
            return (
              <li
                key={key.id}
                className="rounded-xl border border-white/[0.06] bg-surface-2 px-4 py-3.5"
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{key.name}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {key.key_prefix}… · checked{" "}
                      {key.last_verified_at ? formatDateTime(key.last_verified_at) : "never"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={checking === key.id}
                      onClick={() => void verify(key)}
                    >
                      <RefreshCw className={checking === key.id ? "animate-spin" : undefined} />
                      Check
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${key.name}`}
                      onClick={() => setRemoving(key)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                {result && (
                  <p
                    role="status"
                    className={`mt-2.5 flex items-center gap-2 text-xs ${
                      result.status === "valid" ? "text-success-fg" : "text-danger-fg"
                    }`}
                  >
                    {result.status === "valid" ? (
                      <CircleCheck className="size-3.5" />
                    ) : (
                      <CircleAlert className="size-3.5" />
                    )}
                    {describeStatus(result)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <FormDialog
        open={adding}
        title="Add a Firecrawl Cloud key"
        description="We check the key with Firecrawl first, so a wrong key is never saved."
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="add-cloud-key-form"
              disabled={submitting || !name.trim() || !secret.trim()}
            >
              {submitting ? "Checking…" : "Add key"}
            </Button>
          </>
        }
      >
        <form id="add-cloud-key-form" onSubmit={add} className="space-y-4">
          {formError && (
            <div
              role="alert"
              className="rounded-lg border border-danger-muted bg-danger-muted/50 px-3 py-2.5 text-sm text-danger-fg"
            >
              {formError}
            </div>
          )}
          <div className="space-y-1.5">
            <label htmlFor="cloud-key-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="cloud-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              placeholder="e.g. Personal account"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cloud-key-secret" className="text-sm font-medium">
              Firecrawl API key
            </label>
            <Input
              id="cloud-key-secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="fc-…"
              className="font-mono"
              required
            />
          </div>
        </form>
      </FormDialog>

      <ConfirmDialog
        open={removing !== null}
        title="Remove this key?"
        message={`"${removing?.name ?? ""}" is deleted from the gateway. Requests will stop using it, and your gateway API keys keep working with your other Cloud keys.`}
        confirmLabel="Remove key"
        onConfirm={() => removing && void remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
