import { useCallback, useEffect, useState } from "react"
import { Activity, ArrowRight, CheckCircle2, CircleAlert, Clock3, Copy, Gauge, Globe2, RefreshCw } from "lucide-react"
import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import PageLayout from "@/components/PageLayout"
import PageSkeleton from "@/components/PageSkeleton"
import { useToast } from "@/hooks/useToast"
import { formatDate } from "@/lib/date"
import { portalApi } from "./api"
import type { PortalOverview } from "./types"

function enrollmentCopy(status: string) {
  if (status === "enrolled") return { label: "Included tier active", tone: "success" as const, copy: "Your monthly included allowance is available." }
  if (status === "waitlisted") return { label: "Waitlisted", tone: "warning" as const, copy: "You can keep using a healthy BYOK credential while included access is unavailable." }
  if (status === "revoked") return { label: "BYOK only", tone: "warning" as const, copy: "Included access is not active for this workspace." }
  return { label: "Verification pending", tone: "info" as const, copy: "Verify your email to finish account setup." }
}

export default function Dashboard() {
  const [overview, setOverview] = useState<PortalOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const { addToast } = useToast()

  const load = useCallback(async () => {
    try {
      setOverview((await portalApi.overview()).data)
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to load your workspace", "error")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [addToast])

  useEffect(() => { document.title = "Dashboard — Firecrawl Gateway"; void load() }, [load])

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      addToast("Copied to clipboard", "success")
    } catch {
      addToast("Unable to copy from this browser", "error")
    }
  }

  if (loading || !overview) return <PageSkeleton columns={4} rows={5} />
  const tier = enrollmentCopy(overview.quota.enrollment_status)
  const quotaPercent = overview.quota.allocated > 0 ? Math.min(100, (overview.quota.consumed / overview.quota.allocated) * 100) : 0

  return (
    <PageLayout title="Dashboard" icon={Gauge} actions={<Button variant="outline" size="sm" onClick={() => { setRefreshing(true); void load() }} disabled={refreshing}><RefreshCw className={refreshing ? "animate-spin" : ""} />Refresh</Button>}>
      <div className="space-y-4">
        <Card className="overflow-hidden border-white/[0.06] bg-surface-2">
          <CardContent className="grid gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="flex items-start gap-3"><div className="rounded-lg border border-info-muted bg-info-muted/40 p-2.5 text-info-fg"><Globe2 className="size-4" /></div><div><p className="text-[11px] font-medium uppercase tracking-wider text-info-fg">Tenant endpoint</p><h2 className="mt-1 text-sm font-semibold">Your gateway is ready for integration</h2><p className="mt-1 text-xs text-muted-foreground">The endpoint identifier is public routing information. A gateway token is still required for every external request.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"><code className="min-w-0 truncate rounded-md border border-white/[0.08] bg-surface-1 px-3 py-2 font-mono text-xs" title={overview.endpoint_base_url}>{overview.endpoint_base_url}</code><Button variant="outline" size="sm" onClick={() => void copy(overview.endpoint_base_url)}><Copy />Copy URL</Button></div></div></div>
            <Badge variant={overview.endpoint.status === "active" ? "success" : "warning"}><span className="size-1.5 rounded-full bg-current" />{overview.endpoint.status === "active" ? "Active" : "Unavailable"}</Badge>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card><CardHeader className="pb-2"><CardDescription>Included limit</CardDescription><CardTitle className="font-mono text-2xl tabular-nums">{overview.quota.allocated.toLocaleString()}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">Current UTC month</p></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardDescription>Consumed</CardDescription><CardTitle className="font-mono text-2xl tabular-nums">{overview.quota.consumed.toLocaleString()}</CardTitle></CardHeader><CardContent><div className="h-1.5 overflow-hidden rounded-full bg-surface-4"><div className="h-full rounded-full bg-info" style={{ width: `${quotaPercent}%` }} /></div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardDescription>Reserved / in flight</CardDescription><CardTitle className="font-mono text-2xl tabular-nums">{overview.quota.reserved.toLocaleString()}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">Held until the request finishes</p></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardDescription>Remaining</CardDescription><CardTitle className="font-mono text-2xl tabular-nums">{overview.quota.remaining.toLocaleString()}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">Resets {formatDate(overview.quota.reset_at)} UTC</p></CardContent></Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2"><CardHeader><div className="flex items-center justify-between gap-3"><div><CardTitle>Access state</CardTitle><CardDescription className="mt-1">Funding and service availability for this workspace.</CardDescription></div><Badge variant={tier.tone}>{tier.label}</Badge></div></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-lg border border-white/[0.06] bg-surface-3 p-3"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Funding preference</p><p className="mt-1 font-medium capitalize">{overview.account.funding_preference}</p></div><div className="rounded-lg border border-white/[0.06] bg-surface-3 p-3"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Recent included / BYOK</p><p className="mt-1 font-mono font-medium">{overview.recent.included_requests ?? overview.quota.consumed} / {overview.recent.byok_requests ?? 0}</p></div><div className="rounded-lg border border-white/[0.06] bg-surface-3 p-3"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Included traffic</p><p className="mt-1 font-medium">{overview.quota.included_traffic_available ? "Available" : "Not available"}</p></div><div className="rounded-lg border border-white/[0.06] bg-surface-3 p-3"><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Reset date</p><p className="mt-1 font-medium">{formatDate(overview.quota.reset_at)} UTC</p></div><p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">{tier.copy}</p></CardContent></Card>
          <Card><CardHeader><CardTitle>Recent requests</CardTitle><CardDescription>Latest account-scoped summary.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><Activity className="size-4" />Requests</span><strong className="font-mono">{overview.recent.requests}</strong></div><div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="size-4 text-success-fg" />Successful</span><strong className="font-mono">{overview.recent.successful}</strong></div><div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><CircleAlert className="size-4 text-warning-fg" />Errors</span><strong className="font-mono">{overview.recent.errors}</strong></div><div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><Clock3 className="size-4" />Average latency</span><strong className="font-mono">{overview.recent.average_latency_ms} ms</strong></div><Link to="/app/usage" className="inline-flex items-center gap-1 text-sm text-info-fg hover:underline">View usage <ArrowRight className="size-3.5" /></Link></CardContent></Card>
        </div>
      </div>
    </PageLayout>
  )
}
