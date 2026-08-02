import { useCallback, useEffect, useState } from "react"
import { Activity, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import DataTable from "@/components/DataTable"
import EmptyState from "@/components/EmptyState"
import PageLayout from "@/components/PageLayout"
import PageSkeleton from "@/components/PageSkeleton"
import Pagination from "@/components/Pagination"
import { useToast } from "@/hooks/useToast"
import { formatShortDate } from "@/lib/date"
import { portalApi } from "./api"
import type { UsageItem } from "./types"

export default function Usage() {
  const [items, setItems] = useState<UsageItem[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [total, setTotal] = useState(0)
  const [period, setPeriod] = useState("month")
  const [funding, setFunding] = useState("all")
  const [routeFamily, setRouteFamily] = useState("all")
  const [status, setStatus] = useState("all")
  const [latency, setLatency] = useState("all")
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const { addToast } = useToast()

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize), period })
    if (funding !== "all") params.set("funding_type", funding)
    if (routeFamily !== "all") params.set("route_family", routeFamily)
    if (status !== "all") params.set("status", status)
    if (latency !== "all") params.set("latency", latency)
    try {
      const response = await portalApi.usage(params)
      setItems(response.data.items)
      setTotal(response.data.pagination.total)
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Unable to load usage", "error")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [addToast, funding, latency, page, pageSize, period, routeFamily, status])

  useEffect(() => { document.title = "Usage — Firecrawl Gateway"; void load() }, [load])
  if (loading) return <PageSkeleton columns={6} rows={8} />
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <PageLayout title="Usage" icon={Activity} actions={<Button variant="outline" size="sm" onClick={() => { setRefreshing(true); void load() }} disabled={refreshing}><RefreshCw className={refreshing ? "animate-spin" : ""} />Refresh</Button>}>
      <div className="mb-4 grid gap-3 rounded-lg border border-white/[0.06] bg-surface-2 p-4 sm:grid-cols-2 lg:grid-cols-5"><label className="text-xs font-medium text-muted-foreground">Period<Select value={period} onValueChange={(value) => { setPeriod(value); setPage(1) }}><SelectTrigger className="mt-2 h-9 bg-surface-3"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="month">Last 30 days</SelectItem><SelectItem value="7d">Last 7 days</SelectItem><SelectItem value="all">All available</SelectItem></SelectContent></Select></label><label className="text-xs font-medium text-muted-foreground">Funding<Select value={funding} onValueChange={(value) => { setFunding(value); setPage(1) }}><SelectTrigger className="mt-2 h-9 bg-surface-3"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All funding</SelectItem><SelectItem value="included">Included</SelectItem><SelectItem value="byok">BYOK</SelectItem><SelectItem value="unknown">Unknown / automatic</SelectItem></SelectContent></Select></label><label className="text-xs font-medium text-muted-foreground">Endpoint family<Input className="mt-2 h-9 bg-surface-3 font-mono text-xs" value={routeFamily === "all" ? "" : routeFamily} onChange={(event) => { setRouteFamily(event.target.value || "all"); setPage(1) }} placeholder="/v2/scrape" /></label><label className="text-xs font-medium text-muted-foreground">Status<Select value={status} onValueChange={(value) => { setStatus(value); setPage(1) }}><SelectTrigger className="mt-2 h-9 bg-surface-3"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="2xx">Success (2xx)</SelectItem><SelectItem value="4xx">Client errors (4xx)</SelectItem><SelectItem value="5xx">Server errors (5xx)</SelectItem></SelectContent></Select></label><label className="text-xs font-medium text-muted-foreground">Latency<Select value={latency} onValueChange={(value) => { setLatency(value); setPage(1) }}><SelectTrigger className="mt-2 h-9 bg-surface-3"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All latency</SelectItem><SelectItem value="fast">Under 500 ms</SelectItem><SelectItem value="standard">500 ms–2 s</SelectItem><SelectItem value="slow">Over 2 s</SelectItem></SelectContent></Select></label></div>
      <div className="overflow-hidden rounded-lg border border-white/[0.06] bg-surface-2"><DataTable columns={[{ key: "time", header: "Timestamp", className: "text-muted-foreground", render: (item) => formatShortDate(item.timestamp) }, { key: "route", header: "Route family", render: (item) => <code className="font-mono text-xs">{item.route_family}</code> }, { key: "funding", header: "Funding", render: (item) => <Badge variant={item.funding_type === "byok" ? "info" : item.funding_type === "included" ? "success" : "secondary"}>{item.funding_type}</Badge> }, { key: "status", header: "Status", render: (item) => <span className={item.status_bucket === "2xx" ? "text-success-fg" : item.status_bucket === "4xx" ? "text-warning-fg" : "text-danger-fg"}>{item.status}</span> }, { key: "latency", header: "Latency", className: "font-mono text-muted-foreground", render: (item) => `${item.duration_ms} ms` }, { key: "request", header: "Request ID", className: "max-w-[180px] truncate font-mono text-xs text-muted-foreground", render: (item) => item.request_id || "—" }]} data={items} keyExtractor={(item) => item.id} emptyState={<EmptyState icon={Activity} title="No usage in this period" description="Usage appears here after account requests are recorded." />} /><Pagination currentPage={page} totalPages={totalPages} totalItems={total} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1) }} /></div>
    </PageLayout>
  )
}
