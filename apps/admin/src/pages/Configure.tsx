import { useState, useEffect, useCallback } from "react";
import { Settings, Save, RotateCcw, Shield, Route, Database, Bell } from "lucide-react";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { Input } from "@firecrawl-gateway/ui/components/input";
import { Card, CardHeader, CardTitle } from "@firecrawl-gateway/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@firecrawl-gateway/ui/components/select";
import { DEFAULT_ROUTE_MODE, ROUTE_MODES } from "@/lib/routing";
import { useToast } from "@/hooks/useToast";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import PageLayout from "@/components/PageLayout";
import { api } from "@/lib/api";
import type { SettingsData } from "@/types";

/** The key list is managed on the Cloud API Keys page, not here. */
type SettingKey = Exclude<keyof SettingsData, "firecrawl_api_keys" | "telegram_bot_token">;

interface SettingField {
  key: SettingKey;
  label: string;
  description: string;
  type: "number" | "select" | "text";
  category: "security" | "routing" | "cache" | "alerts";
  icon: React.ComponentType<{ className?: string }>;
  min?: number;
  max?: number;
  step?: number;
  /** Shown while the setting has never been saved. */
  defaultValue?: number;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

const FIELDS: SettingField[] = [
  {
    key: "default_route_mode",
    label: "Default Route Mode",
    description:
      "Default routing behavior when no X-Firecrawl-Route-Mode header or query parameter is provided.",
    type: "select",
    category: "routing",
    icon: Route,
    options: [...ROUTE_MODES],
  },
  {
    key: "api_key_inactivity_revoke_days",
    label: "API Key Inactivity Revocation",
    description:
      "Days of inactivity before an API key is automatically revoked. Set to 0 to disable.",
    type: "number",
    category: "security",
    icon: Shield,
    min: 0,
    step: 1,
  },
  {
    key: "response_cache_ttl_seconds",
    label: "Response Cache TTL (seconds)",
    description:
      "How long a successful scrape that would use Firecrawl Cloud is served from the gateway's memory instead of calling Cloud again (cache hits use no credits). Entries are private to the API key that made the request. Set to 0 to turn the cache off.",
    type: "number",
    category: "cache",
    icon: Database,
    min: 0,
    max: 86400,
    step: 1,
    defaultValue: 0,
  },
  {
    key: "alert_credits_low_threshold",
    label: "Low Credits Alert",
    description:
      "Send a Telegram alert when the estimated remaining Cloud credits fall below this number. Set to 0 to disable.",
    type: "number",
    category: "alerts",
    icon: Bell,
    min: 0,
    step: 1,
    defaultValue: 0,
  },
  {
    key: "alert_fallback_ratio_percent",
    label: "High Fallback Rate Alert (%)",
    description:
      "Send a Telegram alert when at least this percent of the last 10 minutes of requests (minimum 20) used a fallback. Set to 0 to disable.",
    type: "number",
    category: "alerts",
    icon: Bell,
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 50,
  },
  {
    key: "telegram_chat_id",
    label: "Telegram Chat ID",
    description:
      "Numeric chat or group id (negative for groups), or @channelname. Alerts are sent only when both a chat id and a bot token are saved.",
    type: "text",
    category: "alerts",
    icon: Bell,
    placeholder: "-1001234567890",
  },
];

const CATEGORIES = [
  { key: "routing" as const, label: "Routing", icon: Route },
  { key: "security" as const, label: "Security & Access", icon: Shield },
  { key: "cache" as const, label: "Response Cache", icon: Database },
  { key: "alerts" as const, label: "Alerts (Telegram)", icon: Bell },
] as const;

export default function Configure() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  // The bot token is write-only: the server returns only a masked form, so a new
  // value is kept apart from `settings` and sent only when the admin typed one.
  const [tokenDraft, setTokenDraft] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const { addToast } = useToast();
  const { confirm: confirmReset, dialog: resetDialog } = useConfirmDialog();

  useEffect(() => {
    document.title = "Configure — Firecrawl Gateway";
  }, []);

  const fetchSettings = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const json = await api.get<{ data: SettingsData }>("/admin/api/settings", { signal });
        if (signal?.aborted) return;
        const data = json.data || {};
        setSettings(data);
        setSavedSnapshot(JSON.stringify(data));
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

  const isDirty =
    Boolean(savedSnapshot) &&
    (JSON.stringify(settings) !== savedSnapshot || tokenDraft.trim() !== "" || removeToken);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  function updateSetting(key: SettingKey, value: unknown) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Partial<SettingsData> = {
        default_route_mode: settings.default_route_mode ?? DEFAULT_ROUTE_MODE,
        api_key_inactivity_revoke_days: settings.api_key_inactivity_revoke_days ?? 0,
        response_cache_ttl_seconds: settings.response_cache_ttl_seconds ?? 0,
        alert_credits_low_threshold: settings.alert_credits_low_threshold ?? 0,
        alert_fallback_ratio_percent: settings.alert_fallback_ratio_percent ?? 50,
        telegram_chat_id: (settings.telegram_chat_id ?? "").trim(),
      };
      // A new token replaces the saved one; "Remove" clears it; otherwise it is not sent at all.
      if (tokenDraft.trim()) payload.telegram_bot_token = tokenDraft.trim();
      else if (removeToken) payload.telegram_bot_token = "";

      const response = await api.put<{ data: Partial<SettingsData> }>(
        "/admin/api/settings",
        payload,
      );
      const next: SettingsData = { ...settings, ...payload };
      // The server echoes the token in its masked form, which is all the UI ever holds.
      if ("telegram_bot_token" in payload)
        next.telegram_bot_token = response.data?.telegram_bot_token ?? "";
      setSettings(next);
      setSavedSnapshot(JSON.stringify(next));
      setTokenDraft("");
      setRemoveToken(false);
      addToast("Settings saved successfully", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    confirmReset({
      title: "Reset Settings",
      message:
        "This will discard any unsaved changes and reload the last saved settings. Are you sure?",
      confirmLabel: "Reset",
      variant: "warning",
      onConfirm: async () => {
        setLoading(true);
        setTokenDraft("");
        setRemoveToken(false);
        await fetchSettings();
        addToast("Settings reset", "success");
      },
    });
  }

  if (loading) {
    return (
      <PageLayout title="Configure" icon={Settings}>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
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
      title="Configure"
      icon={Settings}
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
          <span className="text-warning-fg">You have unsaved configuration changes.</span>
          <span className="text-xs text-muted-foreground">Save before leaving this page.</span>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {CATEGORIES.map((cat) => {
          const catFields = FIELDS.filter((f) => f.category === cat.key);
          if (catFields.length === 0) return null;

          return (
            <Card key={cat.key} className="border-white/[0.06] bg-surface-2 py-0 shadow-none">
              <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
                <div className="flex items-center gap-2">
                  <cat.icon className="size-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-semibold text-foreground">
                    {cat.label}
                  </CardTitle>
                </div>
              </CardHeader>
              <div className="divide-y divide-white/[0.04]">
                {catFields.map((field) => (
                  <div
                    key={field.key}
                    className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.9fr)] lg:items-center lg:gap-6"
                  >
                    <div>
                      <label className="block text-sm font-medium text-foreground">
                        {field.label}
                      </label>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {field.description}
                      </p>
                    </div>
                    {field.type === "select" ? (
                      <Select
                        value={String(settings[field.key] ?? DEFAULT_ROUTE_MODE)}
                        onValueChange={(value) => updateSetting(field.key, value)}
                      >
                        <SelectTrigger className="h-10 w-full text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {field.options?.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : field.type === "text" ? (
                      <Input
                        type="text"
                        autoComplete="off"
                        placeholder={field.placeholder}
                        value={String(settings[field.key] ?? "")}
                        onChange={(e) => updateSetting(field.key, e.target.value)}
                      />
                    ) : (
                      <Input
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={Number(settings[field.key] ?? field.defaultValue ?? 0)}
                        onChange={(e) => {
                          const val = e.target.value === "" ? 0 : Number(e.target.value);
                          updateSetting(field.key, val);
                        }}
                      />
                    )}
                  </div>
                ))}
                {cat.key === "alerts" && (
                  <div className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.9fr)] lg:items-center lg:gap-6">
                    <div>
                      <label
                        htmlFor="telegram-bot-token"
                        className="block text-sm font-medium text-foreground"
                      >
                        Telegram Bot Token
                      </label>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        From @BotFather, shaped like 123456789:AAH.... It is stored encrypted and
                        never shown again; enter a new token to replace it.
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {removeToken
                          ? "The saved token will be removed when you save."
                          : settings.telegram_bot_token
                            ? `Saved: ${settings.telegram_bot_token}`
                            : "No token saved."}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Input
                        id="telegram-bot-token"
                        type="password"
                        autoComplete="off"
                        placeholder="123456789:AAH..."
                        value={tokenDraft}
                        onChange={(e) => {
                          setTokenDraft(e.target.value);
                          if (e.target.value) setRemoveToken(false);
                        }}
                      />
                      {Boolean(settings.telegram_bot_token) && !removeToken && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setTokenDraft("");
                            setRemoveToken(true);
                          }}
                        >
                          Remove saved token
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      {resetDialog}
    </PageLayout>
  );
}
