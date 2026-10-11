import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Key,
  Copy,
  Check,
  RefreshCw,
  Search,
  KeyRound,
  Globe,
  SlidersHorizontal,
} from "lucide-react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@firecrawl-gateway/ui/components/select";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { Input } from "@firecrawl-gateway/ui/components/input";
import { Card } from "@firecrawl-gateway/ui/components/card";
import { FormDialog } from "@/components/FormDialog";
import { ExpiryPicker } from "@/components/ExpiryPicker";
import { useToast } from "@/hooks/useToast";
import Pagination from "@/components/Pagination";
import PageSkeleton from "@/components/PageSkeleton";
import EmptyState from "@/components/EmptyState";
import DataTable from "@/components/DataTable";
import PageLayout from "@/components/PageLayout";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/date";
import { getGatewayUrl } from "@/lib/gateway";
import { formatLatency } from "@/hooks/useAuditMetrics";
import { cn } from "@firecrawl-gateway/ui/lib/utils";
import type { ApiKeyData, ApiKeyUsage } from "@/types";

type KeyState = "active" | "revoked" | "expired";

function keyState(key: ApiKeyData): KeyState {
  if (key.revoked) return "revoked";
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) return "expired";
  return "active";
}

/** `datetime-local` inputs take a local `YYYY-MM-DDTHH:mm` value. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A whole number between 1 and `max`, or null for an empty input; a string is a user-facing error. */
function parseCount(input: string, label: string, max: number): number | null | string {
  if (!input.trim()) return null;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > max)
    return `${label} must be a whole number between 1 and ${max}.`;
  return value;
}

/** Converts the optional limit inputs; a string result is a user-facing error. */
function parseLimits(
  expiresInput: string,
  rateInput: string,
  quotaInput: string,
):
  | {
      expires_at: string | null;
      rate_limit_per_minute: number | null;
      monthly_quota: number | null;
    }
  | string {
  let expires_at: string | null = null;
  if (expiresInput) {
    const date = new Date(expiresInput);
    if (Number.isNaN(date.getTime())) return "Expiry is not a valid date and time.";
    if (date.getTime() <= Date.now()) return "Expiry must be in the future.";
    expires_at = date.toISOString();
  }
  const rate_limit_per_minute = parseCount(rateInput, "Rate limit", 100_000);
  if (typeof rate_limit_per_minute === "string") return rate_limit_per_minute;
  const monthly_quota = parseCount(quotaInput, "Monthly quota", 100_000_000);
  if (typeof monthly_quota === "string") return monthly_quota;
  return { expires_at, rate_limit_per_minute, monthly_quota };
}

export default function ApiKeys() {
  const gatewayUrl = getGatewayUrl();
  const [keys, setKeys] = useState<ApiKeyData[]>([]);
  const [usage, setUsage] = useState<ApiKeyUsage[]>([]);
  // Usage is secondary to the key list, so a slow or failed usage request never blocks it.
  const [usageStatus, setUsageStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const { confirm: confirmRevoke, dialog: confirmDialog } = useConfirmDialog();

  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState("");
  const [newKeyRateLimit, setNewKeyRateLimit] = useState("");
  const [newKeyQuota, setNewKeyQuota] = useState("");
  const [editingKey, setEditingKey] = useState<ApiKeyData | null>(null);
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [editRateLimit, setEditRateLimit] = useState("");
  const [editQuota, setEditQuota] = useState("");
  const [savingLimits, setSavingLimits] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyData | null>(null);
  const [copied, setCopied] = useState(false);
  const [gatewayCopied, setGatewayCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | KeyState>("active");

  // Pagination state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    document.title = "Virtual API Keys — Firecrawl Gateway";
  }, []);

  const filteredKeys = keys.filter((k) => {
    const matchesSearch =
      !searchQuery ||
      k.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      k.key_prefix.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || keyState(k) === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.max(1, Math.ceil(filteredKeys.length / pageSize));
  const paginatedKeys = filteredKeys.slice((page - 1) * pageSize, page * pageSize);

  const fetchKeys = useCallback(async () => {
    try {
      const json = await api.get<{ data: ApiKeyData[] }>("/admin/api/api-keys");
      setKeys(json.data || []);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Error loading virtual API keys", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const fetchUsage = useCallback(async () => {
    try {
      const json = await api.get<{ data: ApiKeyUsage[] }>("/admin/api/usage/api-keys");
      setUsage(Array.isArray(json.data) ? json.data : []);
      setUsageStatus("ready");
    } catch (err) {
      setUsageStatus("error");
      addToast(err instanceof Error ? err.message : "Error loading API key usage", "error");
    }
  }, [addToast]);

  const loadAll = useCallback(
    () => Promise.all([fetchKeys(), fetchUsage()]).then(() => undefined),
    [fetchKeys, fetchUsage],
  );

  useEffect(() => {
    // Load API keys and their usage on mount: standard React pattern for loading authenticated data.
    void loadAll();
  }, [loadAll]);

  const usageByKey = new Map(
    usage.flatMap((item) => (item.api_key_id ? [[item.api_key_id, item] as const] : [])),
  );
  const unattributedRequests = usage.find((item) => item.api_key_id === null)?.total ?? 0;

  /** Renders one usage cell: a placeholder while loading or failed, otherwise the value. */
  function usageCell(key: ApiKeyData, render: (item: ApiKeyUsage | undefined) => React.ReactNode) {
    if (usageStatus === "loading")
      return <span className="text-muted-foreground opacity-60">…</span>;
    if (usageStatus === "error")
      return (
        <span className="text-muted-foreground" title="Usage unavailable">
          —
        </span>
      );
    return render(usageByKey.get(key.id));
  }

  async function handleCreate(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const limits = parseLimits(newKeyExpiresAt, newKeyRateLimit, newKeyQuota);
    if (typeof limits === "string") {
      addToast(limits, "error");
      return;
    }
    setCreating(true);
    try {
      const json = await api.post<{ data: ApiKeyData }>("/admin/api/api-keys", {
        name: newKeyName,
        // Omitted fields mean "no limit"; the server stores null for them.
        ...(limits.expires_at ? { expires_at: limits.expires_at } : {}),
        ...(limits.rate_limit_per_minute
          ? { rate_limit_per_minute: limits.rate_limit_per_minute }
          : {}),
        ...(limits.monthly_quota ? { monthly_quota: limits.monthly_quota } : {}),
      });
      setCreatedKey(json.data);
      setNewKeyName("");
      setNewKeyExpiresAt("");
      setNewKeyRateLimit("");
      setNewKeyQuota("");
      setShowForm(false);
      await fetchKeys();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to create virtual API key", "error");
    } finally {
      setCreating(false);
    }
  }

  function openLimits(key: ApiKeyData) {
    setEditingKey(key);
    setEditExpiresAt(toLocalInput(key.expires_at));
    setEditRateLimit(key.rate_limit_per_minute ? String(key.rate_limit_per_minute) : "");
    setEditQuota(key.monthly_quota ? String(key.monthly_quota) : "");
  }

  async function handleSaveLimits(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editingKey) return;
    // Only fields the user actually changed are sent. The expiry input has minute
    // precision, so resending an untouched value would silently shorten it (and an
    // already-expired key could not have its rate limit edited at all).
    const initialRateLimit = editingKey.rate_limit_per_minute
      ? String(editingKey.rate_limit_per_minute)
      : "";
    const initialQuota = editingKey.monthly_quota ? String(editingKey.monthly_quota) : "";
    const expiresChanged = editExpiresAt !== toLocalInput(editingKey.expires_at);
    const rateLimitChanged = editRateLimit.trim() !== initialRateLimit;
    const quotaChanged = editQuota.trim() !== initialQuota;
    if (!expiresChanged && !rateLimitChanged && !quotaChanged) {
      setEditingKey(null);
      return;
    }
    const limits = parseLimits(
      expiresChanged ? editExpiresAt : "",
      rateLimitChanged ? editRateLimit : "",
      quotaChanged ? editQuota : "",
    );
    if (typeof limits === "string") {
      addToast(limits, "error");
      return;
    }
    setSavingLimits(true);
    try {
      // An emptied input is sent as null, which clears that limit.
      await api.patch(`/admin/api/api-keys/${editingKey.id}`, {
        ...(expiresChanged ? { expires_at: limits.expires_at } : {}),
        ...(rateLimitChanged ? { rate_limit_per_minute: limits.rate_limit_per_minute } : {}),
        ...(quotaChanged ? { monthly_quota: limits.monthly_quota } : {}),
      });
      addToast("Key limits updated", "success");
      setEditingKey(null);
      await fetchKeys();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update key limits", "error");
    } finally {
      setSavingLimits(false);
    }
  }

  async function doRevoke(id: string) {
    try {
      await api.delete(`/admin/api/api-keys/${id}`);
      addToast("Virtual API key revoked", "success");
      await fetchKeys();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to revoke virtual API key", "error");
    }
  }

  function handleRevoke(id: string) {
    confirmRevoke({
      title: "Revoke Virtual API Key",
      message:
        "Are you sure you want to revoke this virtual API key? This action cannot be undone.",
      confirmLabel: "Revoke",
      variant: "warning",
      onConfirm: () => doRevoke(id),
    });
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast("Failed to copy virtual API key", "error");
    }
  }

  async function copyGatewayUrl() {
    try {
      await navigator.clipboard.writeText(gatewayUrl);
      setGatewayCopied(true);
      setTimeout(() => setGatewayCopied(false), 2000);
    } catch {
      addToast("Failed to copy gateway URL", "error");
    }
  }

  if (loading) {
    return <PageSkeleton columns={6} rows={6} />;
  }

  return (
    <PageLayout
      title="Virtual API Keys"
      icon={Key}
      count={{ filtered: filteredKeys.length, total: keys.length }}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void loadAll().then(() => setRefreshing(false));
            }}
            disabled={refreshing}
          >
            <RefreshCw className={`size-4 mr-1 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setShowForm(true);
              setCreatedKey(null);
            }}
          >
            <Plus className="size-4 mr-1" /> New key
          </Button>
        </>
      }
    >
      <Card className="mb-5 overflow-hidden border-white/[0.06] bg-surface-2 py-0 shadow-none">
        <div className="flex flex-col gap-5 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-lg border border-info-muted bg-info-muted/40 p-2.5 text-info-fg">
              <Globe className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-info-fg">
                Connection details
              </p>
              <h2 className="mt-1 text-sm font-semibold text-foreground">
                Use your gateway endpoint
              </h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Send Firecrawl API requests through this URL using one of your active virtual API
                keys.
              </p>
              <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <code
                  className="min-w-0 flex-1 truncate rounded-md border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-xs text-foreground"
                  title={gatewayUrl}
                >
                  {gatewayUrl}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 sm:self-stretch"
                  onClick={() => void copyGatewayUrl()}
                  aria-label={gatewayCopied ? "Gateway endpoint copied" : "Copy gateway endpoint"}
                >
                  {gatewayCopied ? (
                    <Check className="size-4 mr-1" />
                  ) : (
                    <Copy className="size-4 mr-1" />
                  )}
                  {gatewayCopied ? "Copied" : "Copy URL"}
                </Button>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2 border-t border-white/[0.06] pt-4 text-xs lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <div>
              <p className="font-medium text-foreground">Supported API paths</p>
              <div className="mt-2 flex gap-2 font-mono text-muted-foreground">
                <span className="rounded-md bg-surface-3 px-2 py-1">/v1/*</span>
                <span className="rounded-md bg-surface-3 px-2 py-1">/v2/*</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Active keys",
            value: keys.filter((k) => keyState(k) === "active").length,
            tone: "text-success-fg",
          },
          {
            label: "Revoked keys",
            value: keys.filter((k) => keyState(k) === "revoked").length,
            tone: "text-danger-fg",
          },
          {
            label: "Expired keys",
            value: keys.filter((k) => keyState(k) === "expired").length,
            tone: "text-danger-fg",
          },
          {
            label: "Never used",
            value: keys.filter((k) => !k.last_used_at && keyState(k) === "active").length,
            tone: "text-warning-fg",
          },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-white/[0.06] bg-surface-2 px-4 py-3"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {item.label}
            </p>
            <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${item.tone}`}>
              {item.value}
            </p>
          </div>
        ))}
      </div>

      {/* Search & Filter Bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search by name or prefix..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="pl-9 pr-3"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v as "all" | KeyState);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-10 bg-surface-3 text-sm px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
        {(searchQuery || statusFilter !== "active") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("active");
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {createdKey && (
        <div className="mb-6 rounded-lg border border-success-muted bg-success-muted/30 p-4 space-y-2">
          <p className="text-sm font-medium text-success-fg">
            Virtual API key created. Copy it now — it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-surface-2 px-3 py-2 text-sm font-mono text-foreground">
              {createdKey.key}
            </code>
            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => createdKey.key && copyKey(createdKey.key)}
              aria-label={copied ? "Virtual API key copied" : "Copy virtual API key"}
              title={copied ? "Copied" : "Copy virtual API key"}
            >
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setCreatedKey(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      <FormDialog
        open={showForm}
        title="Create virtual API key"
        description="Name this key so you can identify its environment or application later."
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button type="submit" form="create-api-key-form" size="sm" disabled={creating}>
              {creating ? "Creating..." : "Create key"}
            </Button>
          </>
        }
      >
        <form id="create-api-key-form" onSubmit={handleCreate} className="space-y-2">
          <label htmlFor="new-api-key-name" className="block text-sm font-medium text-foreground">
            Key name
          </label>
          <Input
            id="new-api-key-name"
            placeholder="e.g. Production, Development"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            required
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Use a name that describes where this key is used.
          </p>
          <div className="grid gap-3 pt-2 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="new-api-key-expires"
                className="block text-sm font-medium text-foreground"
              >
                Expires <span className="text-xs text-muted-foreground">(optional)</span>
              </label>
              <ExpiryPicker
                id="new-api-key-expires"
                value={newKeyExpiresAt}
                onChange={setNewKeyExpiresAt}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="new-api-key-rate-limit"
                className="block text-sm font-medium text-foreground"
              >
                Rate limit <span className="text-xs text-muted-foreground">(requests/min)</span>
              </label>
              <Input
                id="new-api-key-rate-limit"
                type="number"
                inputMode="numeric"
                min={1}
                max={100000}
                step={1}
                placeholder="No limit"
                value={newKeyRateLimit}
                onChange={(e) => setNewKeyRateLimit(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <label
                htmlFor="new-api-key-quota"
                className="block text-sm font-medium text-foreground"
              >
                Monthly quota{" "}
                <span className="text-xs text-muted-foreground">(requests/month)</span>
              </label>
              <Input
                id="new-api-key-quota"
                type="number"
                inputMode="numeric"
                min={1}
                max={100000000}
                step={1}
                placeholder="No quota"
                value={newKeyQuota}
                onChange={(e) => setNewKeyQuota(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            All three are optional. Limits are enforced per key and are approximate across
            instances; the quota resets at the start of each UTC month.
          </p>
        </form>
      </FormDialog>

      <FormDialog
        open={editingKey !== null}
        title="Edit key limits"
        description={
          editingKey
            ? `Limits for ${editingKey.name} (${editingKey.key_prefix}...). Leave a field empty to remove that limit.`
            : ""
        }
        onClose={() => setEditingKey(null)}
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(null)}>
              Cancel
            </Button>
            <Button type="submit" form="edit-api-key-form" size="sm" disabled={savingLimits}>
              {savingLimits ? "Saving..." : "Save limits"}
            </Button>
          </>
        }
      >
        <form id="edit-api-key-form" onSubmit={handleSaveLimits} className="space-y-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="edit-api-key-expires"
                className="block text-sm font-medium text-foreground"
              >
                Expires
              </label>
              <ExpiryPicker
                id="edit-api-key-expires"
                value={editExpiresAt}
                onChange={setEditExpiresAt}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="edit-api-key-rate-limit"
                className="block text-sm font-medium text-foreground"
              >
                Rate limit <span className="text-xs text-muted-foreground">(requests/min)</span>
              </label>
              <Input
                id="edit-api-key-rate-limit"
                type="number"
                inputMode="numeric"
                min={1}
                max={100000}
                step={1}
                placeholder="No limit"
                value={editRateLimit}
                onChange={(e) => setEditRateLimit(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <label
                htmlFor="edit-api-key-quota"
                className="block text-sm font-medium text-foreground"
              >
                Monthly quota{" "}
                <span className="text-xs text-muted-foreground">(requests/month)</span>
              </label>
              <Input
                id="edit-api-key-quota"
                type="number"
                inputMode="numeric"
                min={1}
                max={100000000}
                step={1}
                placeholder="No quota"
                value={editQuota}
                onChange={(e) => setEditQuota(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Changes apply to the next request. An expired key is rejected with 401.
          </p>
        </form>
      </FormDialog>

      <div className="rounded-lg border border-white/[0.06] bg-surface-2 overflow-hidden">
        <DataTable
          columns={[
            { key: "name", header: "Name", render: (k) => k.name },
            {
              key: "prefix",
              header: "Prefix",
              className: "font-mono text-muted-foreground",
              render: (k) => (
                <div className="flex items-center gap-1.5">
                  <span>{k.key_prefix}...</span>
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (k) => {
                const state = keyState(k);
                return state === "revoked" ? (
                  <span className="rounded-md bg-danger-muted px-2 py-0.5 text-xs text-danger-fg">
                    Revoked
                  </span>
                ) : state === "expired" ? (
                  <span className="rounded-md bg-warning-muted px-2 py-0.5 text-xs text-warning-fg">
                    Expired
                  </span>
                ) : (
                  <span className="rounded-md bg-success-muted px-2 py-0.5 text-xs text-success-fg">
                    Active
                  </span>
                );
              },
            },
            {
              key: "limits",
              header: "Limits",
              render: (k) => (
                <div className="space-y-0.5 text-xs">
                  <div
                    className={cn(
                      "font-mono tabular-nums",
                      k.rate_limit_per_minute ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {k.rate_limit_per_minute
                      ? `${k.rate_limit_per_minute.toLocaleString()}/min`
                      : "No rate limit"}
                  </div>
                  <div
                    className={cn(
                      "font-mono tabular-nums",
                      k.monthly_quota &&
                        typeof k.quota_used === "number" &&
                        k.quota_used >= k.monthly_quota
                        ? "text-danger-fg"
                        : k.monthly_quota
                          ? "text-foreground"
                          : "text-muted-foreground",
                    )}
                  >
                    {k.monthly_quota
                      ? `${(k.quota_used ?? 0).toLocaleString()} / ${k.monthly_quota.toLocaleString()} this month`
                      : "No monthly quota"}
                  </div>
                  <div className="text-muted-foreground">
                    {k.expires_at ? `Expires ${formatDate(k.expires_at)}` : "Never expires"}
                  </div>
                </div>
              ),
            },
            {
              key: "created",
              header: "Created",
              className: "text-muted-foreground",
              render: (k) => formatDate(k.created_at),
            },
            {
              key: "lastUsed",
              header: "Last Used",
              className: "text-muted-foreground",
              render: (k) =>
                k.last_used_at ? (
                  formatDate(k.last_used_at)
                ) : (
                  <span className="text-xs italic opacity-60">Never</span>
                ),
            },
            {
              key: "requests",
              header: "Requests",
              align: "right",
              className: "font-mono tabular-nums",
              render: (k) => usageCell(k, (item) => (item ? item.total.toLocaleString() : "0")),
            },
            {
              key: "errors",
              header: "Errors",
              align: "right",
              className: "font-mono tabular-nums",
              render: (k) =>
                usageCell(k, (item) => (
                  <span
                    className={cn(
                      item && item.error_count > 0 ? "text-danger-fg" : "text-muted-foreground",
                    )}
                  >
                    {(item?.error_count ?? 0).toLocaleString()}
                  </span>
                )),
            },
            {
              key: "fallbacks",
              header: "Fallbacks",
              align: "right",
              className: "font-mono tabular-nums",
              render: (k) =>
                usageCell(k, (item) => (
                  <span
                    className={cn(
                      item && item.fallbacks > 0 ? "text-warning-fg" : "text-muted-foreground",
                    )}
                  >
                    {(item?.fallbacks ?? 0).toLocaleString()}
                  </span>
                )),
            },
            {
              key: "latency",
              header: "Avg latency",
              align: "right",
              className: "font-mono tabular-nums text-muted-foreground",
              render: (k) =>
                usageCell(k, (item) =>
                  item && item.total > 0 ? formatLatency(item.avg_duration_ms) : "—",
                ),
            },
            {
              key: "actions",
              header: "Actions",
              align: "right",
              render: (k) => (
                <div className="flex justify-end gap-2">
                  {!k.revoked && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      onClick={() => openLimits(k)}
                      aria-label={`Edit limits for ${k.name}`}
                    >
                      <SlidersHorizontal className="size-3 mr-1" /> Limits
                    </Button>
                  )}
                  {!k.revoked && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 border-danger-muted bg-danger-muted/30 text-danger-fg hover:bg-danger-muted/50"
                      onClick={() => handleRevoke(k.id)}
                    >
                      <Trash2 className="size-3 mr-1" /> Revoke
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
          data={paginatedKeys}
          keyExtractor={(k) => k.id}
          emptyState={
            <EmptyState
              icon={KeyRound}
              title={
                keys.length === 0
                  ? "No virtual API keys found"
                  : "No virtual API keys match your filters"
              }
              description={
                keys.length === 0
                  ? "Create your first virtual API key to start using the gateway."
                  : "Try adjusting your search or filter criteria."
              }
              action={
                keys.length === 0
                  ? { label: "Create key", onClick: () => setShowForm(true) }
                  : undefined
              }
            />
          }
        />
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={filteredKeys.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Usage comes from the retained audit log: entries older than 30 days are purged and deleting
        request history lowers these counts.
        {usageStatus === "ready" && unattributedRequests > 0 && (
          <>
            {" "}
            {unattributedRequests.toLocaleString()} logged{" "}
            {unattributedRequests === 1 ? "request is" : "requests are"} not attributed to a key
            (admin playground, rejected requests, or logged before key attribution).
          </>
        )}
      </p>

      {confirmDialog}
    </PageLayout>
  );
}
