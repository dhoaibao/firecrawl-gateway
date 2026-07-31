import { useState, useEffect, useCallback, useRef } from "react"
import {
  Settings,
  Save,
  RotateCcw,
  Plus,
  Trash2,
  Shield,
  CreditCard,
  RefreshCw,
  Route,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DEFAULT_ROUTE_MODE, ROUTE_MODES } from "@/lib/routing"
import { useToast } from "@/hooks/useToast"
import { useConfirmDialog } from "@/components/ConfirmDialog"
import PageLayout from "@/components/PageLayout"
import { api } from "@/lib/api"
import type { SettingsData, CreditUsageItem } from "@/types"

type SettingKey = keyof SettingsData

interface SettingField {
  key: SettingKey
  label: string
  description: string
  type: "number" | "select" | "text"
  category: "security" | "cloud" | "routing"
  icon: React.ComponentType<{ className?: string }>
  min?: number
  step?: number
  options?: { value: string; label: string }[]
}

const FIELDS: SettingField[] = [
  {
    key: "self_hosted_firecrawl_url",
    label: "Self-hosted Firecrawl URL",
    description: "URL of the external self-hosted Firecrawl instance.",
    type: "text",
    category: "routing",
    icon: Route,
  },
  {
    key: "default_route_mode",
    label: "Default Route Mode",
    description: "Default routing behavior when no X-Firecrawl-Route-Mode header or query parameter is provided.",
    type: "select",
    category: "routing",
    icon: Route,
    options: [...ROUTE_MODES],
  },
  {
    key: "user_inactivity_suspend_days",
    label: "User Inactivity Suspension",
    description: "Days of inactivity before a user account is automatically suspended. Set to 0 to disable.",
    type: "number",
    category: "security",
    icon: Shield,
    min: 0,
    step: 1,
  },
  {
    key: "api_key_inactivity_revoke_days",
    label: "API Key Inactivity Revocation",
    description: "Days of inactivity before an API key is automatically revoked. Set to 0 to disable.",
    type: "number",
    category: "security",
    icon: Shield,
    min: 0,
    step: 1,
  },
]

const CATEGORIES = [
  { key: "routing" as const, label: "Routing", icon: Route },
  { key: "security" as const, label: "Security & Access", icon: Shield },
  { key: "cloud" as const, label: "Firecrawl Cloud API Keys", icon: CreditCard },
] as const

interface ApiKeyRow {
  id: string
  key: string
}

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

function makeRows(keys: string[], idCounter: { current: number }): ApiKeyRow[] {
  return keys.map((key) => ({ id: `key-${idCounter.current++}`, key }))
}

function ApiKeyRow({
  row,
  usage,
  onRemove,
}: {
  row: ApiKeyRow
  usage: CreditUsageItem | undefined
  onRemove: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <code className="truncate text-sm font-mono text-foreground" title={row.key}>
            {maskKey(row.key)}
          </code>
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
            {usage.remainingCredits?.toLocaleString() ?? "—"} / {usage.planCredits?.toLocaleString() ?? "—"} credits
          </span>
          <span>
            Renews on {usage.billingPeriodEnd
              ? new Date(usage.billingPeriodEnd).toLocaleDateString()
              : "—"}
          </span>
        </div>
      ) : null}
    </div>
  )
}

export default function Configure() {
  const [settings, setSettings] = useState<SettingsData>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [apiKeyRows, setApiKeyRows] = useState<ApiKeyRow[]>([])
  const [newKey, setNewKey] = useState("")
  const [creditUsage, setCreditUsage] = useState<CreditUsageItem[]>([])
  const [creditUsageLoading, setCreditUsageLoading] = useState(false)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const idCounter = useRef(0)
  const { addToast } = useToast()
  const { confirm: confirmReset, dialog: resetDialog } = useConfirmDialog()
  const successfulCreditUsage = creditUsage.filter(
    (usage) => !usage.error && typeof usage.remainingCredits === "number",
  )
  const totalRemainingCredits = successfulCreditUsage.reduce(
    (total, usage) => total + (usage.remainingCredits ?? 0),
    0,
  )
  const totalPlanCredits = successfulCreditUsage.reduce(
    (total, usage) => total + (usage.planCredits ?? 0),
    0,
  )

  useEffect(() => {
    document.title = "Configure — Firecrawl Gateway"
  }, [])

  const fetchCreditUsage = useCallback(async (signal?: AbortSignal) => {
    setCreditUsageLoading(true)
    try {
      const json = await api.get<{ data: CreditUsageItem[] }>("/admin/api/settings/credit-usage", { signal })
      if (signal?.aborted) return
      setCreditUsage(json.data || [])
    } catch (err) {
      if (signal?.aborted) return
      addToast(err instanceof Error ? err.message : "Failed to load credit usage", "error")
    } finally {
      if (!signal?.aborted) {
        setCreditUsageLoading(false)
      }
    }
  }, [addToast])

  const fetchSettings = useCallback(async (signal?: AbortSignal) => {
    try {
      const json = await api.get<{ data: SettingsData }>("/admin/api/settings", { signal })
      if (signal?.aborted) return
      const data = json.data || {}
      setSettings(data)
      idCounter.current = 0
      const rows = makeRows(data.firecrawl_api_keys || [], idCounter)
      setApiKeyRows(rows)
      setSavedSnapshot(JSON.stringify({ settings: data, keys: rows.map((row) => row.key) }))
    } catch (err) {
      if (signal?.aborted) return
      addToast(err instanceof Error ? err.message : "Failed to load settings", "error")
    } finally {
      if (!signal?.aborted) {
        setLoading(false)
      }
    }
  }, [addToast])

  useEffect(() => {
    const controller = new AbortController()
    void fetchSettings(controller.signal)
    return () => controller.abort()
  }, [fetchSettings])

  useEffect(() => {
    const controller = new AbortController()
    void fetchCreditUsage(controller.signal)
    return () => controller.abort()
  }, [fetchCreditUsage])

  const currentSnapshot = JSON.stringify({
    settings,
    keys: apiKeyRows.map((row) => row.key),
  })
  const isDirty = Boolean(savedSnapshot) && currentSnapshot !== savedSnapshot

  useEffect(() => {
    if (!isDirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [isDirty])

  function updateSetting(key: SettingKey, value: unknown) {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  function addApiKey() {
    const trimmed = newKey.trim()
    if (!trimmed) return
    if (apiKeyRows.some((row) => row.key === trimmed)) {
      addToast("This key is already in the list", "error")
      return
    }
    setApiKeyRows((prev) => [...prev, { id: `key-${idCounter.current++}`, key: trimmed }])
    setNewKey("")
  }

  function removeApiKey(index: number) {
    setApiKeyRows((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSave() {
    setSaving(true)
    try {
      const payload: Partial<SettingsData> = {
        firecrawl_api_keys: apiKeyRows.map((row) => row.key),
        self_hosted_firecrawl_url: settings.self_hosted_firecrawl_url ?? "",
        default_route_mode: settings.default_route_mode ?? DEFAULT_ROUTE_MODE,
        user_inactivity_suspend_days: settings.user_inactivity_suspend_days ?? 0,
        api_key_inactivity_revoke_days: settings.api_key_inactivity_revoke_days ?? 0,
      }

      await api.put<{ data: SettingsData }>("/admin/api/settings", payload)
      setSettings((prev) => ({ ...prev, ...payload }))
      setSavedSnapshot(JSON.stringify({ settings: { ...settings, ...payload }, keys: payload.firecrawl_api_keys }))
      await fetchCreditUsage()
      addToast("Settings saved successfully", "success")
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to save settings", "error")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    confirmReset({
      title: "Reset Settings",
      message: "This will discard any unsaved changes and reload the last saved settings. Are you sure?",
      confirmLabel: "Reset",
      variant: "warning",
      onConfirm: async () => {
        setLoading(true)
        await fetchSettings()
        addToast("Settings reset", "success")
      },
    })
  }

  if (loading) {
    return (
      <PageLayout
        title="Configure"
        icon={Settings}
      >
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="h-40 animate-pulse border-white/[0.06] bg-surface-2">
              <div className="h-full bg-white/[0.02]" />
            </Card>
          ))}
        </div>
      </PageLayout>
    )
  }

  return (
    <PageLayout
      title="Configure"
      icon={Settings}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleReset()}
            disabled={saving}
          >
            <RotateCcw className="size-4 mr-1" /> Reset
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            <Save className="size-4 mr-1" /> {saving ? "Saving..." : isDirty ? "Save Changes" : "Saved"}
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
          const catFields = FIELDS.filter((f) => f.category === cat.key)
          if (cat.key === "cloud") {
            return (
              <Card key={cat.key} className="border-white/[0.06] bg-surface-2 py-0 shadow-none lg:col-span-2">
                <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
                  <div className="flex items-center gap-2">
                    <cat.icon className="size-4 text-muted-foreground" />
                    <CardTitle className="text-sm font-semibold text-foreground">{cat.label}</CardTitle>
                  </div>
                </CardHeader>
                <div className="space-y-4 px-5 py-4">
                  <p className="text-sm text-muted-foreground">
                    Add Firecrawl API keys. The gateway uses the key with the most remaining credits first, randomizing ties, and tries the remaining keys on rate limits or auth errors.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="text"
                      placeholder="Enter Firecrawl API key..."
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addApiKey() } }}
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
                        No API keys configured. Cloud fallback and cloud-first routing will not work until you add at least one key.
                      </div>
                    )}
                    {apiKeyRows.map((row, i) => (
                      <ApiKeyRow
                        key={row.id}
                        row={row}
                        usage={creditUsage[i]}
                        onRemove={() => removeApiKey(i)}
                      />
                    ))}
                  </div>
                </div>
              </Card>
            )
          }

          if (catFields.length === 0) return null

          return (
            <Card key={cat.key} className="border-white/[0.06] bg-surface-2 py-0 shadow-none">
              <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
                <div className="flex items-center gap-2">
                  <cat.icon className="size-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-semibold text-foreground">{cat.label}</CardTitle>
                </div>
              </CardHeader>
              <div className="divide-y divide-white/[0.04]">
                {catFields.map((field) => (
                  <div key={field.key} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.9fr)] lg:items-center lg:gap-6">
                    <div>
                      <label className="block text-sm font-medium text-foreground">
                        {field.label}
                      </label>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{field.description}</p>
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
                        type="url"
                        value={settings[field.key] ?? ""}
                        onChange={(e) => updateSetting(field.key, e.target.value)}
                        placeholder="https://your-firecrawl-instance.example.com"
                      />
                    ) : (
                      <Input
                        type="number"
                        min={field.min}
                        step={field.step}
                        value={settings[field.key] ?? 0}
                        onChange={(e) => {
                          const val = e.target.value === "" ? 0 : Number(e.target.value)
                          updateSetting(field.key, val)
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )
        })}
      </div>
      {resetDialog}
    </PageLayout>
  )
}
