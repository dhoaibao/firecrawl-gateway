import { useState, useEffect, useCallback, useRef } from "react";
import { Save, RotateCcw, Plus, Trash2, CreditCard, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/useToast";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import PageLayout from "@/components/PageLayout";
import { api } from "@/lib/api";
import { creditKeyPrefix, nextUpPrefixes } from "@/lib/credits";
import { Badge } from "@/components/ui/badge";
import type { SettingsData, CreditUsageItem } from "@/types";

interface ApiKeyRow {
  id: string;
  key: string;
}

function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function makeRows(keys: string[], idCounter: { current: number }): ApiKeyRow[] {
  return keys.map((key) => ({ id: `key-${idCounter.current++}`, key }));
}

function ApiKeyRow({
  row,
  usage,
  nextUp,
  tiedForNext,
  onRemove,
}: {
  row: ApiKeyRow;
  usage: CreditUsageItem | undefined;
  nextUp: boolean;
  tiedForNext: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <code className="truncate text-sm font-mono text-foreground" title={row.key}>
            {maskKey(row.key)}
          </code>
          {nextUp && (
            <Badge
              variant="success"
              title={
                tiedForNext
                  ? "Tied on renewal day and credits; the gateway picks one at random"
                  : "Renews soonest, so the gateway uses this key first"
              }
            >
              {tiedForNext ? "Tied for next" : "Next up"}
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 border-danger-muted bg-danger-muted/30 text-danger-fg hover:bg-danger-muted/50 shrink-0"
          onClick={onRemove}
        >
          <Trash2 className="size-3 mr-1" /> Remove
        </Button>
      </div>
      {usage?.error ? (
        <p className="text-xs text-danger-fg">{usage.error}</p>
      ) : usage ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {usage.remainingCredits?.toLocaleString() ?? "—"} /{" "}
            {usage.planCredits?.toLocaleString() ?? "—"} credits
          </span>
          <span>
            Renews on{" "}
            {usage.billingPeriodEnd ? new Date(usage.billingPeriodEnd).toLocaleDateString() : "—"}
          </span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Credit usage appears after this key is saved.
        </p>
      )}
    </div>
  );
}

export default function CloudKeys() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiKeyRows, setApiKeyRows] = useState<ApiKeyRow[]>([]);
  const [newKey, setNewKey] = useState("");
  const [creditUsage, setCreditUsage] = useState<CreditUsageItem[]>([]);
  const [creditUsageLoading, setCreditUsageLoading] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const idCounter = useRef(0);
  const { addToast } = useToast();
  const { confirm: confirmReset, dialog: resetDialog } = useConfirmDialog();
  const usageByPrefix = new Map(creditUsage.map((item) => [item.keyPrefix, item]));
  const nextUpSet = nextUpPrefixes(creditUsage);
  const successfulCreditUsage = creditUsage.filter(
    (usage) => !usage.error && typeof usage.remainingCredits === "number",
  );
  const totalRemainingCredits = successfulCreditUsage.reduce(
    (total, usage) => total + (usage.remainingCredits ?? 0),
    0,
  );
  const totalPlanCredits = successfulCreditUsage.reduce(
    (total, usage) => total + (usage.planCredits ?? 0),
    0,
  );

  useEffect(() => {
    document.title = "Cloud API Keys — Firecrawl Gateway";
  }, []);

  const fetchCreditUsage = useCallback(
    async (signal?: AbortSignal) => {
      setCreditUsageLoading(true);
      try {
        const json = await api.get<{ data: CreditUsageItem[] }>(
          "/admin/api/settings/credit-usage",
          { signal },
        );
        if (signal?.aborted) return;
        setCreditUsage(json.data || []);
      } catch (err) {
        if (signal?.aborted) return;
        addToast(err instanceof Error ? err.message : "Failed to load credit usage", "error");
      } finally {
        if (!signal?.aborted) {
          setCreditUsageLoading(false);
        }
      }
    },
    [addToast],
  );

  const fetchSettings = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const json = await api.get<{ data: SettingsData }>("/admin/api/settings", { signal });
        if (signal?.aborted) return;
        const data = json.data || {};
        idCounter.current = 0;
        const rows = makeRows(data.firecrawl_api_keys || [], idCounter);
        setApiKeyRows(rows);
        setSavedSnapshot(JSON.stringify(rows.map((row) => row.key)));
      } catch (err) {
        if (signal?.aborted) return;
        addToast(err instanceof Error ? err.message : "Failed to load settings", "error");
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [addToast],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchSettings(controller.signal);
    return () => controller.abort();
  }, [fetchSettings]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCreditUsage(controller.signal);
    return () => controller.abort();
  }, [fetchCreditUsage]);

  const isDirty =
    Boolean(savedSnapshot) && JSON.stringify(apiKeyRows.map((row) => row.key)) !== savedSnapshot;

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  function addApiKey() {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    if (apiKeyRows.some((row) => row.key === trimmed)) {
      addToast("This key is already in the list", "error");
      return;
    }
    setApiKeyRows((prev) => [...prev, { id: `key-${idCounter.current++}`, key: trimmed }]);
    setNewKey("");
  }

  function removeApiKey(index: number) {
    setApiKeyRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const keys = apiKeyRows.map((row) => row.key);
      await api.put<{ data: SettingsData }>("/admin/api/settings", { firecrawl_api_keys: keys });
      setSavedSnapshot(JSON.stringify(keys));
      await fetchCreditUsage();
      addToast("Cloud API keys saved successfully", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save cloud API keys", "error");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    confirmReset({
      title: "Reset Cloud API Keys",
      message:
        "This will discard any unsaved changes and reload the last saved keys. Are you sure?",
      confirmLabel: "Reset",
      variant: "warning",
      onConfirm: async () => {
        setLoading(true);
        await fetchSettings();
        addToast("Cloud API keys reset", "success");
      },
    });
  }

  if (loading) {
    return (
      <PageLayout title="Cloud API Keys" icon={CreditCard}>
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="h-40 animate-pulse border-white/[0.06] bg-surface-2">
              <div className="h-full bg-white/[0.02]" />
            </Card>
          ))}
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Cloud API Keys"
      icon={CreditCard}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => void handleReset()} disabled={saving}>
            <RotateCcw className="size-4 mr-1" /> Reset
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            <Save className="size-4 mr-1" />{" "}
            {saving ? "Saving..." : isDirty ? "Save Changes" : "Saved"}
          </Button>
        </>
      }
    >
      {isDirty && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-warning-muted/60 bg-warning-muted/20 px-4 py-3 text-sm">
          <span className="text-warning-fg">You have unsaved changes.</span>
          <span className="text-xs text-muted-foreground">Save before leaving this page.</span>
        </div>
      )}
      <Card className="border-white/[0.06] bg-surface-2 py-0 shadow-none">
        <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <CreditCard className="size-4 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold text-foreground">
              Firecrawl Cloud API Keys
            </CardTitle>
          </div>
        </CardHeader>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-muted-foreground">
            Add Firecrawl API keys. The gateway uses the key that renews soonest first; on the same
            renewal day it prefers the key with more remaining credits, picking randomly on equal
            credits. It tries the remaining keys on rate limits or auth errors.
          </p>
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="Enter Firecrawl API key..."
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addApiKey();
                }
              }}
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={addApiKey}>
              <Plus className="size-4 mr-1" /> Add
            </Button>
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rounded-md border border-white/[0.06] bg-white/[0.04] p-2 text-muted-foreground">
                <CreditCard className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Total available credits
                </p>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-xl font-semibold tabular-nums text-foreground">
                    {creditUsageLoading && creditUsage.length === 0
                      ? "—"
                      : totalRemainingCredits.toLocaleString()}
                  </span>
                  {!creditUsageLoading && successfulCreditUsage.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      of {totalPlanCredits.toLocaleString()} combined plan credits
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {creditUsageLoading
                    ? "Refreshing credit balances..."
                    : creditUsage.length === 0
                      ? "No saved API keys"
                      : `${successfulCreditUsage.length} of ${creditUsage.length} key balances included${successfulCreditUsage.length < creditUsage.length ? ` · ${creditUsage.length - successfulCreditUsage.length} unavailable` : ""}`}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void fetchCreditUsage()}
              disabled={creditUsageLoading}
            >
              <RefreshCw className={`size-4 mr-1 ${creditUsageLoading ? "animate-spin" : ""}`} />
              {creditUsageLoading ? "Refreshing..." : "Refresh usage"}
            </Button>
          </div>
          <div className="space-y-2">
            {apiKeyRows.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-surface-1 px-4 py-3 text-sm text-muted-foreground">
                No API keys configured. Cloud fallback and cloud-first routing will not work until
                you add at least one key.
              </div>
            )}
            {apiKeyRows.map((row, i) => {
              const prefix = creditKeyPrefix(row.key);
              return (
                <ApiKeyRow
                  key={row.id}
                  row={row}
                  usage={usageByPrefix.get(prefix)}
                  nextUp={nextUpSet.has(prefix)}
                  tiedForNext={nextUpSet.has(prefix) && nextUpSet.size > 1}
                  onRemove={() => removeApiKey(i)}
                />
              );
            })}
          </div>
        </div>
      </Card>
      {resetDialog}
    </PageLayout>
  );
}
