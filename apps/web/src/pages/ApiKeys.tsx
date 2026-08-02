import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Key, Copy, Check, RefreshCw, Search, KeyRound, Globe } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/hooks/useToast";
import Pagination from "@/components/Pagination";
import PageSkeleton from "@/components/PageSkeleton";
import EmptyState from "@/components/EmptyState";
import DataTable from "@/components/DataTable";
import PageLayout from "@/components/PageLayout";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/date";
import { getGatewayUrl } from "@/lib/gateway";
import type { ApiKeyData } from "@/types";

export default function ApiKeys() {
  const gatewayUrl = getGatewayUrl();
  const [keys, setKeys] = useState<ApiKeyData[]>([]);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const { user } = useAuth();
  const { confirm: confirmRevoke, dialog: confirmDialog } = useConfirmDialog();

  const [newKeyName, setNewKeyName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revocationPassword, setRevocationPassword] = useState("");
  const [revocationMfa, setRevocationMfa] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyData | null>(null);
  const [copied, setCopied] = useState(false);
  const [gatewayCopied, setGatewayCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "revoked">("active");

  // Pagination state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => { document.title = "API Keys — Firecrawl Gateway" }, []);

  const filteredKeys = keys.filter((k) => {
    const matchesSearch =
      !searchQuery ||
      k.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      k.key_prefix.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" ? (k.status ? k.status === "active" : !k.revoked) : k.status ? k.status === "revoked" : k.revoked);
    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.max(1, Math.ceil(filteredKeys.length / pageSize));
  const paginatedKeys = filteredKeys.slice((page - 1) * pageSize, page * pageSize);

  const fetchKeys = useCallback(async () => {
    try {
      const json = await api.get<{ data: ApiKeyData[] }>("/admin/api/api-keys");
      setKeys(json.data || []);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Error loading API keys", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    // Load API keys on mount: standard React pattern for loading authenticated data.
    void fetchKeys();
  }, [fetchKeys]);

  async function handleCreate(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user) return;
    setCreating(true);
    try {
      const json = await api.post<{ data: ApiKeyData }>("/admin/api/api-keys", {
        name: newKeyName,
        current_password: currentPassword,
        ...(mfaCode.length === 6 ? { mfa_code: mfaCode } : mfaCode ? { recovery_code: mfaCode } : {}),
      });
      setCreatedKey(json.data);
      setNewKeyName("");
      setCurrentPassword("");
      setMfaCode("");
      setShowForm(false);
      await fetchKeys();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to create API key", "error");
    } finally {
      setCreating(false);
    }
  }

  async function doRevoke(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!revokingId) return;
    setRevoking(true);
    try {
      await api.delete(`/admin/api/api-keys/${revokingId}`, {
        current_password: revocationPassword,
        ...(revocationMfa.length === 6 ? { mfa_code: revocationMfa } : { recovery_code: revocationMfa }),
      });
      setRevokingId(null);
      setRevocationPassword("");
      setRevocationMfa("");
      addToast("API key revoked", "success");
      await fetchKeys();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to revoke API key", "error");
    } finally {
      setRevoking(false);
    }
  }

  function handleRevoke(id: string) {
    confirmRevoke({
      title: "Revoke API Key",
      message: "Are you sure you want to revoke this API key? This action cannot be undone.",
      confirmLabel: "Revoke",
      variant: "warning",
      onConfirm: () => { setRevocationPassword(""); setRevocationMfa(""); setRevokingId(id); },
    });
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast("Failed to copy API key", "error");
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
      title="API Keys"
      icon={Key}
      count={{ filtered: filteredKeys.length, total: keys.length }}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setRefreshing(true); void fetchKeys().then(() => setRefreshing(false)); }}
            disabled={refreshing}
          >
            <RefreshCw className={`size-4 mr-1 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button size="sm" onClick={() => { setShowForm(true); setCreatedKey(null); }}>
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
              <p className="text-[11px] font-medium uppercase tracking-wider text-info-fg">Connection details</p>
              <h2 className="mt-1 text-sm font-semibold text-foreground">Use your gateway endpoint</h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Send Firecrawl API requests through this URL using one of your active virtual API keys.
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
                  {gatewayCopied ? <Check className="size-4 mr-1" /> : <Copy className="size-4 mr-1" />}
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

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[
          { label: "Active keys", value: keys.filter((k) => k.status ? k.status === "active" : !k.revoked).length, tone: "text-success-fg" },
          { label: "Revoked keys", value: keys.filter((k) => k.status ? k.status === "revoked" : k.revoked).length, tone: "text-danger-fg" },
          { label: "Never used", value: keys.filter((k) => !k.last_used_at && (k.status ? k.status === "active" : !k.revoked)).length, tone: "text-warning-fg" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-white/[0.06] bg-surface-2 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{item.label}</p>
            <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${item.tone}`}>{item.value}</p>
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
            onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
            className="pl-9 pr-3"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as "all" | "active" | "revoked"); setPage(1); }}>
          <SelectTrigger className="h-10 bg-surface-3 text-sm px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
        {(searchQuery || statusFilter !== "active") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setSearchQuery(""); setStatusFilter("active"); setPage(1); }}
          >
            Clear
          </Button>
        )}
      </div>

      {createdKey && (
        <div className="mb-6 rounded-lg border border-success-muted bg-success-muted/30 p-4 space-y-2">
          <p className="text-sm font-medium text-success-fg">Gateway token created. Copy it now; it will not be shown again after this message is dismissed.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-surface-2 px-3 py-2 text-sm font-mono text-foreground">
              {createdKey.key}
            </code>
            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => createdKey.key && copyKey(createdKey.key)}
              aria-label={copied ? "API key copied" : "Copy API key"}
              title={copied ? "Copied" : "Copy API key"}
            >
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <button onClick={() => setCreatedKey(null)} className="text-sm text-muted-foreground hover:text-foreground">
            Dismiss
          </button>
        </div>
      )}

      <Dialog
        open={showForm}
        title="Create API key"
        description="Name this key so you can identify its environment or application later."
        onClose={() => { setShowForm(false); setCurrentPassword(""); setMfaCode(""); }}
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button type="submit" form="create-api-key-form" size="sm" disabled={creating || !currentPassword}>
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
          <p className="text-xs text-muted-foreground">Use a name that describes where this key is used.</p>
          <label htmlFor="api-key-current-password" className="mt-3 block text-sm font-medium text-foreground">Current password</label>
          <Input id="api-key-current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
          <label htmlFor="api-key-mfa" className="mt-3 block text-sm font-medium text-foreground">Authenticator or recovery code</label>
          <Input id="api-key-mfa" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoComplete="one-time-code" />
        </form>
      </Dialog>

      <Dialog open={Boolean(revokingId)} title="Revoke API key" description="Confirm your current credentials to revoke this key." onClose={() => { if (!revoking) setRevokingId(null) }} footer={<><Button variant="outline" size="sm" onClick={() => setRevokingId(null)} disabled={revoking}>Cancel</Button><Button variant="destructive" type="submit" form="revoke-api-key-form" size="sm" disabled={revoking || !revocationPassword}>{revoking ? "Revoking..." : "Revoke key"}</Button></>}>
        <form id="revoke-api-key-form" onSubmit={doRevoke} className="space-y-2">
          <label htmlFor="revoke-api-key-password" className="block text-sm font-medium text-foreground">Current password</label>
          <Input id="revoke-api-key-password" type="password" value={revocationPassword} onChange={(e) => setRevocationPassword(e.target.value)} autoComplete="current-password" required />
          <label htmlFor="revoke-api-key-mfa" className="mt-3 block text-sm font-medium text-foreground">Authenticator or recovery code</label>
          <Input id="revoke-api-key-mfa" value={revocationMfa} onChange={(e) => setRevocationMfa(e.target.value)} autoComplete="one-time-code" />
        </form>
      </Dialog>

      <div className="rounded-lg border border-white/[0.06] bg-surface-2 overflow-hidden">
        <DataTable
          columns={[
            { key: "name", header: "Name", render: (k) => k.name },
            {
              key: "prefix",
              header: "Prefix",
              className: "font-mono text-muted-foreground",
              render: (k) => <span>{k.key_prefix}...</span>,
            },
            {
              key: "status",
              header: "Status",
              render: (k) =>
                (k.status ?? (k.revoked ? "revoked" : "active")) === "revoked" ? (
                  <span className="rounded-md bg-danger-muted px-2 py-0.5 text-xs text-danger-fg">Revoked</span>
                ) : (k.status ?? "active") === "active" ? (
                  <span className="rounded-md bg-success-muted px-2 py-0.5 text-xs text-success-fg">Active</span>
                ) : (
                  <span className="rounded-md bg-warning-muted px-2 py-0.5 text-xs text-warning-fg">{k.status}</span>
                ),
            },
            { key: "created", header: "Created", className: "text-muted-foreground", render: (k) => formatDate(k.created_at) },
            {
              key: "lastUsed",
              header: "Last Used",
              className: "text-muted-foreground",
              render: (k) =>
                k.last_used_at ? formatDate(k.last_used_at) : <span className="text-xs italic opacity-60">Never</span>,
            },
            {
              key: "actions",
              header: "Actions",
              align: "right",
              render: (k) => (
                <div className="flex justify-end gap-2">
                  {(k.status ? k.status === "active" : !k.revoked) && (
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
              title={keys.length === 0 ? "No API keys found" : "No API keys match your filters"}
              description={keys.length === 0 ? "Create your first API key to start using the gateway." : "Try adjusting your search or filter criteria."}
              action={keys.length === 0 ? { label: "Create key", onClick: () => setShowForm(true) } : undefined}
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

      {confirmDialog}
    </PageLayout>
  );
}
