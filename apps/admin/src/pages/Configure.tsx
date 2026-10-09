import { useState, useEffect, useCallback } from "react";
import { Settings, Save, RotateCcw, Shield, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_ROUTE_MODE, ROUTE_MODES } from "@/lib/routing";
import { useToast } from "@/hooks/useToast";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import PageLayout from "@/components/PageLayout";
import { api } from "@/lib/api";
import type { SettingsData } from "@/types";

type SettingKey = keyof SettingsData;

interface SettingField {
  key: SettingKey;
  label: string;
  description: string;
  type: "number" | "select";
  category: "security" | "routing";
  icon: React.ComponentType<{ className?: string }>;
  min?: number;
  step?: number;
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
];

const CATEGORIES = [
  { key: "routing" as const, label: "Routing", icon: Route },
  { key: "security" as const, label: "Security & Access", icon: Shield },
] as const;

export default function Configure() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState("");
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

  const isDirty = Boolean(savedSnapshot) && JSON.stringify(settings) !== savedSnapshot;

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
      };

      await api.put<{ data: SettingsData }>("/admin/api/settings", payload);
      const next = { ...settings, ...payload };
      setSettings(next);
      setSavedSnapshot(JSON.stringify(next));
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
                    ) : (
                      <Input
                        type="number"
                        min={field.min}
                        step={field.step}
                        value={settings[field.key] ?? 0}
                        onChange={(e) => {
                          const val = e.target.value === "" ? 0 : Number(e.target.value);
                          updateSetting(field.key, val);
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
      {resetDialog}
    </PageLayout>
  );
}
