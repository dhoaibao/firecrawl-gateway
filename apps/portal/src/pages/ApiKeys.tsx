import { useEffect, useState } from "react";
import { KeyRound, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { Input } from "@firecrawl-gateway/ui/components/input";
import { Badge } from "@firecrawl-gateway/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@firecrawl-gateway/ui/components/table";
import { api } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ApiKey, CreatedApiKey } from "@/lib/types";
import { useResource } from "@/hooks/useResource";
import { useToast } from "@/contexts/ToastContext";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CopyButton } from "@/components/CopyButton";
import { FormDialog } from "@/components/FormDialog";
import { PageHeader } from "@/components/PageHeader";
import { EmptyBlock, LoadError, LoadingRows } from "@/components/StateViews";

interface KeyLimits {
  limits: { max_keys: number; rate_limit_per_minute: number };
}

const EXPIRY_OPTIONS = [
  { value: "never", label: "Never expires", days: null },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
] as const;

const FIELD =
  "h-10 w-full rounded-md border border-white/[0.08] bg-surface-1 px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30";

export default function ApiKeys() {
  const { addToast } = useToast();
  const keys = useResource<ApiKey[], KeyLimits>("/portal/api/api-keys");
  const limits = keys.body?.limits ?? null;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>("never");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  useEffect(() => {
    document.title = "API keys — Firecrawl Gateway";
  }, []);

  const list = keys.data ?? [];
  const atLimit = limits !== null && list.length >= limits.max_keys;

  function openCreate() {
    setName("");
    setExpiry("never");
    setCreating(true);
  }

  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const days = EXPIRY_OPTIONS.find((option) => option.value === expiry)?.days ?? null;
    setSubmitting(true);
    try {
      const response = await api.post<{ data: CreatedApiKey }>("/portal/api/api-keys", {
        name,
        ...(days ? { expires_at: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
      });
      setCreating(false);
      setCreated(response.data);
      keys.reload();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Could not create the key");
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(key: ApiKey) {
    setRevoking(null);
    try {
      await api.delete(`/portal/api/api-keys/${encodeURIComponent(key.id)}`);
      addToast(`Revoked "${key.name}"`, "success");
      keys.reload();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Could not revoke the key");
    }
  }

  return (
    <>
      <PageHeader
        title="API keys"
        description="Use these keys with the gateway's /v1 and /v2 endpoints. Requests run on your own Firecrawl Cloud keys."
        actions={
          <Button type="button" onClick={openCreate} disabled={atLimit}>
            <Plus /> Create key
          </Button>
        }
      />

      {limits && (
        <p className="mb-4 text-xs text-muted-foreground">
          {list.length} of {limits.max_keys} keys · {limits.rate_limit_per_minute} requests per
          minute each
        </p>
      )}

      {keys.loading && !keys.data ? (
        <LoadingRows />
      ) : keys.error ? (
        <LoadError message={keys.error} onRetry={keys.reload} />
      ) : list.length === 0 ? (
        <EmptyBlock
          icon={KeyRound}
          title="No API keys yet"
          description="Create a key, then send it as a Bearer token. Add a Firecrawl Cloud key first so requests have credits to run on."
          action={{ label: "Create key", onClick: openCreate }}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-surface-2">
          <Table>
            <TableHeader>
              <TableRow className="bg-surface-3 hover:bg-surface-3">
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead className="hidden sm:table-cell">Last used</TableHead>
                <TableHead className="hidden lg:table-cell">Expires</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {key.key_prefix}…
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {formatDate(key.created_at)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {key.last_used_at ? formatDateTime(key.last_used_at) : "Never"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {key.expires_at ? (
                      <Badge variant="outline">{formatDate(key.expires_at)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Revoke ${key.name}`}
                      onClick={() => setRevoking(key)}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <FormDialog
        open={creating}
        title="Create API key"
        description="Name the key after where it will be used."
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" form="create-key-form" disabled={submitting || !name.trim()}>
              {submitting ? "Creating…" : "Create key"}
            </Button>
          </>
        }
      >
        <form id="create-key-form" onSubmit={create} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="key-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              placeholder="e.g. CI pipeline"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="key-expiry" className="text-sm font-medium">
              Expiry
            </label>
            <select
              id="key-expiry"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              className={FIELD}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </form>
      </FormDialog>

      <FormDialog
        open={created !== null}
        title="Copy your new key"
        onClose={() => setCreated(null)}
        footer={
          <Button type="button" onClick={() => setCreated(null)}>
            I have saved it
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-warning-muted bg-warning-muted/40 px-3 py-2.5 text-sm text-warning-fg">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            This is the only time the full key is shown. Store it somewhere safe; if you lose it,
            create a new one.
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">{created?.name}</p>
            <code className="block break-all rounded-lg border border-white/[0.08] bg-surface-1 px-3 py-2.5 font-mono text-xs text-foreground">
              {created?.key}
            </code>
            {created && <CopyButton value={created.key} label="Copy key" />}
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this key?"
        message={`"${revoking?.name ?? ""}" stops working immediately. Anything still using it will receive 401 errors.`}
        confirmLabel="Revoke key"
        onConfirm={() => revoking && void revoke(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}
