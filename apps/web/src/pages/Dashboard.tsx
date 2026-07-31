import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  Download,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useToast } from "@/hooks/useToast"
import { useAuditMetrics, formatPercent, buildRequestBuckets } from "@/hooks/useAuditMetrics"
import { RequestVolumeChart } from "@/components/RequestVolumeChart"
import { StatusCodeChart } from "@/components/StatusCodeChart"
import { TopEndpointsChart } from "@/components/TopEndpointsChart"
import { LatencyDistributionChart } from "@/components/LatencyDistributionChart"
import { LogTableRow } from "@/components/LogTableRow"
import AuditDetailDrawer from "@/components/AuditDetailDrawer"
import MetricsGrid from "@/components/MetricsGrid"
import FilterBar from "@/components/FilterBar"
import DeleteHistoryDialog from "@/components/DeleteHistoryDialog"
import { useConfirmDialog } from "@/components/ConfirmDialog"
import type { AuditEntry, UserData, BackendFilter, StatusFilter, DateRange, CreditUsageItem } from "@/types"

const datePresets: Array<{ label: string; value: DateRange }> = [
  { label: "All", value: "all" },
  { label: "Today", value: "today" },
  { label: "This Week", value: "week" },
  { label: "This Month", value: "month" },
]

const pageSizeOptions = [10, 25, 50, 100]

/* ------------------------------------------------------------------ */
/*  Table skeleton                                                     */
/* ------------------------------------------------------------------ */
function TableSkeleton({ rowCount = 8 }: { rowCount?: number }) {
  // Keep inline to avoid extra file; visually identical to original
  return (
    <>
      <div className="min-w-[1220px]">
        <div className="flex h-10 items-center gap-4 border-b border-white/[0.06] bg-surface-3 px-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-3 flex-1 animate-pulse rounded bg-white/[0.06]" style={{ minWidth: i === 0 ? 140 : 80 }} />
          ))}
        </div>
        {Array.from({ length: rowCount }).map((_, rowIdx) => (
          <div key={rowIdx} className="flex h-12 items-center gap-4 border-b border-white/[0.04] bg-surface-1 px-5">
            {Array.from({ length: 10 }).map((__, colIdx) => (
              <div key={colIdx} className="h-3 flex-1 animate-pulse rounded bg-white/[0.06]" style={{ minWidth: colIdx === 0 ? 140 : 80 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.06] bg-surface-1 px-5 py-3">
        <div className="h-3 w-40 animate-pulse rounded bg-white/[0.06]" />
        <div className="flex items-center gap-3">
          <div className="h-8 w-20 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-8 w-28 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-8 w-28 animate-pulse rounded bg-white/[0.06]" />
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Dashboard                                                          */
/* ------------------------------------------------------------------ */
export default function Dashboard() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [users, setUsers] = useState<UserData[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(true)
  const [backendFilter, setBackendFilter] = useState<BackendFilter>("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("")
  const [fallbackOnly, setFallbackOnly] = useState(false)
  const [slowOnly, setSlowOnly] = useState(false)
  const [search, setSearch] = useState("")
  const [dateRange, setDateRange] = useState<DateRange>("all")
  const [dayFilter, setDayFilter] = useState("all")
  const [monthFilter, setMonthFilter] = useState("all")
  const [yearFilter, setYearFilter] = useState("all")
  const [userFilter, setUserFilter] = useState("all")
  const [pageSize, setPageSize] = useState(25)
  const [currentPage, setCurrentPage] = useState(1)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteFilter, setDeleteFilter] = useState<"today" | "week" | "month" | "all">("today")
  const [deleting, setDeleting] = useState(false)
  const [creditUsage, setCreditUsage] = useState<CreditUsageItem[]>([])
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const fetchingRef = useRef(false)
  const creditUsageFetchingRef = useRef(false)

  useEffect(() => { document.title = "Dashboard — Firecrawl Gateway" }, [])

  const { addToast } = useToast()
  const { confirm: confirmDelete, dialog: confirmDialog } = useConfirmDialog()

  const fetchData = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    try {
      const json = await api.get<{
        data: AuditEntry[]
        users: UserData[]
      }>("/admin/api/data")
      setEntries(Array.isArray(json.data) ? json.data : [])
      setUsers(Array.isArray(json.users) ? json.users : [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load audit data"
      addToast(msg, "error")
    } finally {
      fetchingRef.current = false
      setLoading(false)
    }
  }, [addToast])

  const fetchCreditUsage = useCallback(async () => {
    if (creditUsageFetchingRef.current) return
    creditUsageFetchingRef.current = true
    try {
      const json = await api.get<{ data: CreditUsageItem[] }>("/admin/api/settings/credit-usage")
      setCreditUsage(Array.isArray(json.data) ? json.data : [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load credit usage"
      addToast(msg, "error")
    } finally {
      creditUsageFetchingRef.current = false
    }
  }, [addToast])

  const handleDeleteEntry = useCallback(async (id: string) => {
    try {
      await api.delete(`/admin/api/logs/${encodeURIComponent(id)}`)
      addToast("Log deleted", "success")
      setSelectedEntry(null)
      setSelectedIds((current) => {
        if (!current.has(id)) return current
        const next = new Set(current)
        next.delete(id)
        return next
      })
      void fetchData()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete log"
      addToast(msg, "error")
    }
  }, [addToast, fetchData])

  const confirmDeleteEntry = useCallback((entry: AuditEntry) => {
    confirmDelete({
      title: "Delete log",
      message: "Are you sure you want to delete this request log? This action cannot be undone.",
      confirmLabel: "Delete",
      variant: "danger",
      onConfirm: () => void handleDeleteEntry(entry.id),
    })
  }, [confirmDelete, handleDeleteEntry])

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return

    setDeleting(true)
    try {
      const json = await api.delete<{ deleted: number }>(
        "/admin/api/logs",
        { ids },
      )
      addToast(`${json.deleted} ${json.deleted === 1 ? "log" : "logs"} deleted`, "success")
      setSelectedIds(new Set())
      setSelectedEntry(null)
      void fetchData()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete selected logs"
      addToast(msg, "error")
    } finally {
      setDeleting(false)
    }
  }, [selectedIds, addToast, fetchData])

  const confirmDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    confirmDelete({
      title: "Delete selected logs",
      message: `Are you sure you want to delete ${selectedIds.size} selected ${selectedIds.size === 1 ? "log" : "logs"}? This action cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
      onConfirm: () => void handleDeleteSelected(),
    })
  }, [confirmDelete, handleDeleteSelected, selectedIds.size])

  const handleDeleteHistory = useCallback(async () => {
    setDeleting(true)
    try {
      const json = await api.delete<{ deleted: number }>(
        `/admin/api/logs?filter=${deleteFilter}`,
      )
      addToast(
        json.deleted === -1
          ? "All history deleted"
          : `${json.deleted} entries deleted`,
        "success",
      )
      setShowDeleteDialog(false)
      setSelectedIds(new Set())
      void fetchData()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete history"
      addToast(msg, "error")
    } finally {
      setDeleting(false)
    }
  }, [deleteFilter, addToast, fetchData])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void fetchData()
      void fetchCreditUsage()
    }, 0)

    let interval: number | undefined
    const refreshWhenVisible = () => {
      if (live && !document.hidden) {
        void fetchData()
        void fetchCreditUsage()
      }
    }
    if (live) {
      interval = window.setInterval(refreshWhenVisible, 5000)
      document.addEventListener("visibilitychange", refreshWhenVisible)
    }

    return () => {
      window.clearTimeout(initialLoad)
      if (interval) window.clearInterval(interval)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
  }, [fetchData, fetchCreditUsage, live])

  const filteredEntries = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    return entries.filter((entry) => {
      if (
        normalizedSearch &&
        ![entry.path, entry.target_url, entry.method, entry.backend_used, entry.route_mode, entry.fallback_reason]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch)
      ) {
        return false
      }
      if (backendFilter && entry.backend_used !== backendFilter) return false
      if (fallbackOnly && !entry.fallback_used) return false
      if (slowOnly && entry.duration_ms < 1000) return false
      if (statusFilter === "2xx" && !(entry.status_code >= 200 && entry.status_code < 300)) return false
      if (statusFilter === "4xx" && !(entry.status_code >= 400 && entry.status_code < 500)) return false
      if (statusFilter === "5xx" && !(entry.status_code >= 500 && entry.status_code < 600)) return false

      const entryDate = new Date(entry.created_at)
      const now = new Date()
      if (dateRange === "today") {
        if (
          entryDate.getDate() !== now.getDate() ||
          entryDate.getMonth() !== now.getMonth() ||
          entryDate.getFullYear() !== now.getFullYear()
        ) {
          return false
        }
      } else if (dateRange === "week") {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        weekAgo.setHours(0, 0, 0, 0)
        if (entryDate < weekAgo) return false
      } else if (dateRange === "month") {
        if (
          entryDate.getMonth() !== now.getMonth() ||
          entryDate.getFullYear() !== now.getFullYear()
        ) {
          return false
        }
      } else if (dateRange === "custom") {
        if (dayFilter !== "all") {
          const day = String(entryDate.getDate()).padStart(2, "0")
          if (day !== dayFilter) return false
        }
        if (monthFilter !== "all") {
          const month = String(entryDate.getMonth() + 1).padStart(2, "0")
          if (month !== monthFilter) return false
        }
        if (yearFilter !== "all") {
          const year = String(entryDate.getFullYear())
          if (year !== yearFilter) return false
        }
      }
      if (userFilter !== "all" && entry.user_id !== userFilter) return false
      return true
    })
  }, [backendFilter, entries, fallbackOnly, slowOnly, search, statusFilter, dateRange, dayFilter, monthFilter, yearFilter, userFilter])

  const metrics = useAuditMetrics(filteredEntries)
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const visiblePage = Math.min(currentPage, pageCount)
  const pageStart = filteredEntries.length ? (visiblePage - 1) * pageSize : 0
  const pageEnd = Math.min(pageStart + pageSize, filteredEntries.length)
  const paginatedEntries = filteredEntries.slice(pageStart, pageEnd)
  const allVisibleSelected = paginatedEntries.length > 0 && paginatedEntries.every((entry) => selectedIds.has(entry.id))
  const toggleEntrySelection = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const toggleVisibleSelection = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        paginatedEntries.forEach((entry) => next.delete(entry.id))
      } else {
        paginatedEntries.forEach((entry) => next.add(entry.id))
      }
      return next
    })
  }, [allVisibleSelected, paginatedEntries])
  const requestBuckets = useMemo(() => buildRequestBuckets(filteredEntries), [filteredEntries])

  // Active filter chips
  const activeFilters = useMemo(() => {
    const filters: Array<{ key: string; label: string; clear: () => void }> = []
    if (dateRange !== "all") {
      const preset = datePresets.find((p) => p.value === dateRange)
      filters.push({
        key: "dateRange",
        label: preset?.label || "Custom",
        clear: () => setDateRange("all"),
      })
    }
    if (dayFilter !== "all" && dateRange === "custom") {
      filters.push({ key: "day", label: `Day: ${dayFilter}`, clear: () => setDayFilter("all") })
    }
    if (monthFilter !== "all" && dateRange === "custom") {
      filters.push({ key: "month", label: `Month: ${monthFilter}`, clear: () => setMonthFilter("all") })
    }
    if (yearFilter !== "all" && dateRange === "custom") {
      filters.push({ key: "year", label: `Year: ${yearFilter}`, clear: () => setYearFilter("all") })
    }
    if (backendFilter) {
      filters.push({
        key: "backend",
        label: `Backend: ${backendFilter.charAt(0).toUpperCase() + backendFilter.slice(1)}`,
        clear: () => setBackendFilter(""),
      })
    }
    if (fallbackOnly) {
      filters.push({ key: "fallback", label: "Fallback", clear: () => setFallbackOnly(false) })
    }
    if (statusFilter) {
      const label =
        statusFilter === "2xx" ? "2xx" :
        statusFilter === "4xx" ? "4xx" :
        statusFilter === "5xx" ? "5xx" : statusFilter
      filters.push({ key: "status", label: `Status: ${label}`, clear: () => setStatusFilter("") })
    }
    if (userFilter !== "all") {
      const u = users.find((usr) => usr.id === userFilter)
      filters.push({
        key: "user",
        label: `User: ${u?.name || u?.email || userFilter.slice(0, 8)}`,
        clear: () => setUserFilter("all"),
      })
    }
    if (slowOnly) {
      filters.push({ key: "slow", label: "Slow: >1s", clear: () => setSlowOnly(false) })
    }
    if (search.trim()) {
      filters.push({ key: "search", label: `Search: "${search.trim()}"`, clear: () => setSearch("") })
    }
    return filters
  }, [dateRange, dayFilter, monthFilter, yearFilter, backendFilter, fallbackOnly, slowOnly, statusFilter, userFilter, search, users])

  const applySavedView = useCallback((view: "errors" | "fallbacks" | "slow") => {
    setDateRange("today")
    setDayFilter("all")
    setMonthFilter("all")
    setYearFilter("all")
    setUserFilter("all")
    setSearch("")
    setCurrentPage(1)
    if (view === "errors") {
      setSlowOnly(false)
      setStatusFilter("5xx")
      setBackendFilter("")
      setFallbackOnly(false)
    } else if (view === "fallbacks") {
      setSlowOnly(false)
      setStatusFilter("")
      setBackendFilter("")
      setFallbackOnly(true)
    } else {
      setStatusFilter("")
      setBackendFilter("")
      setFallbackOnly(false)
      setSlowOnly(true)
    }
  }, [])

  const copyDetailValue = useCallback(async (field: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopiedField(field)
    window.setTimeout(() => setCopiedField(null), 2000)
  }, [])

  const exportFilteredEntries = useCallback(() => {
    const headers = ["id", "created_at", "method", "path", "route_mode", "backend_used", "fallback_used", "fallback_reason", "status_code", "duration_ms", "target_url", "user_id"]
    const csv = [headers, ...filteredEntries.map((entry) => headers.map((header) => String(entry[header as keyof AuditEntry] ?? "")))]
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","))
      .join("\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `gateway-audit-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }, [filteredEntries])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === "/") {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('input[placeholder="Search logs"]')?.focus()
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault()
        void fetchData()
      }
    }
    document.addEventListener("keydown", handleShortcut)
    return () => document.removeEventListener("keydown", handleShortcut)
  }, [fetchData])

  const closeAuditDrawer = useCallback(() => {
    setSelectedEntry(null)
  }, [])

  const handleCopyDetailValue = useCallback((field: string, value: string) => {
    void copyDetailValue(field, value)
  }, [copyDetailValue])

  const clearAllFilters = useCallback(() => {
    setDateRange("all")
    setDayFilter("all")
    setMonthFilter("all")
    setYearFilter("all")
    setBackendFilter("")
    setFallbackOnly(false)
    setSlowOnly(false)
    setStatusFilter("")
    setUserFilter("all")
    setSearch("")
    setCurrentPage(1)
  }, [])

  return (
    <main id="content" className="min-h-screen bg-background text-foreground">
      {/* Sticky header */}
      <section className="sticky top-0 z-20 border-b border-white/[0.06] bg-surface-2/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 py-3 lg:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <div className="flex items-center gap-3 lg:mr-2 lg:shrink-0">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-surface-3 text-muted-foreground">
                <Activity className="size-4" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-semibold tracking-tight text-foreground">Gateway overview</h1>
                <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={cn("size-1.5 rounded-full", live ? "bg-success" : "bg-muted-foreground")} />
                  {live ? "Monitoring live traffic" : "Live updates paused"}
                </p>
              </div>
            </div>

            {/* Live status */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={live ? "default" : "outline"}
                className={cn(
                  "gap-2 border-white/[0.08] shadow-none transition-all",
                  live
                    ? "border-success-muted bg-surface-3 text-foreground hover:bg-surface-4"
                    : "bg-surface-3 text-muted-foreground hover:bg-surface-4 hover:text-foreground",
                )}
                onClick={() => setLive((v) => !v)}
              >
                <span className={cn("relative flex size-2", live && "animate-pulse-soft")}>
                  <span className={cn("absolute inline-flex size-full rounded-full opacity-75", live ? "bg-success" : "bg-muted-foreground")} />
                  <span className={cn("relative inline-flex size-2 rounded-full", live ? "bg-success" : "bg-muted-foreground")} />
                </span>
                {live ? "Live" : "Paused"}
              </Button>
            </div>

            {/* Center: Search */}
            <div className="relative min-w-0 flex-1 lg:min-w-[16rem]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Search logs"
                className="bg-surface-2 pl-10"
              />
            </div>

            {/* Right: GitHub link */}
            <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
              <Button
                variant="outline"
                onClick={exportFilteredEntries}
                disabled={filteredEntries.length === 0}
                title="Export filtered audit logs"
              >
                <Download className="mr-1 size-4" /> Export
              </Button>
              <Button
                asChild
                variant="outline"
                className="border-white/[0.08] bg-surface-3 text-foreground shadow-none transition-colors hover:bg-surface-4"
              >
                <a href="https://github.com/dhoaibao/firecrawl-gateway" target="_blank" rel="noreferrer">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="size-4 mr-1">
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.524.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
                  </svg>
                  GitHub
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto flex max-w-[1680px] flex-col gap-4 px-4 py-6 lg:px-6">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Overview</p>
          <h2 className="mt-1 text-base font-semibold tracking-tight text-foreground">Gateway health at a glance</h2>
        </div>

        <MetricsGrid metrics={metrics} loading={loading} creditUsage={creditUsage} />

        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Traffic analysis</p>
          <h2 className="mt-1 text-base font-semibold tracking-tight text-foreground">Requests and performance</h2>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="gap-0 overflow-hidden rounded-lg border-white/[0.06] bg-surface-2 py-0 shadow-none">
            <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="size-4 text-muted-foreground" />
                    <CardTitle className="text-sm font-semibold text-foreground">Gateway Request Volume</CardTitle>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2 rounded-full bg-success" /> Success
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2 rounded-full bg-danger" /> Error
                    </span>
                  </div>
                </div>
                <div role="img" aria-label={`Request volume chart showing ${requestBuckets.reduce((sum, b) => sum + b.success + b.error, 0)} requests across ${requestBuckets.length} time buckets`}>
                  <RequestVolumeChart buckets={requestBuckets} />
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="gap-0 overflow-hidden rounded-lg border-white/[0.06] bg-surface-2 py-0 shadow-none">
            <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-semibold text-foreground">Status Code Distribution</CardTitle>
                </div>
                <div role="img" aria-label={`Status code distribution for ${filteredEntries.length} requests`}>
                  <StatusCodeChart entries={filteredEntries} />
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="gap-0 overflow-hidden rounded-lg border-white/[0.06] bg-surface-2 py-0 shadow-none">
            <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <Server className="size-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-semibold text-foreground">Top Endpoints</CardTitle>
                </div>
                <div role="img" aria-label={`Top endpoints chart for ${filteredEntries.length} requests`}>
                  <TopEndpointsChart entries={filteredEntries} />
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="gap-0 overflow-hidden rounded-lg border-white/[0.06] bg-surface-2 py-0 shadow-none">
            <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <Clock className="size-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-semibold text-foreground">Latency Distribution</CardTitle>
                </div>
                <div role="img" aria-label={`Latency distribution for ${filteredEntries.length} requests`}>
                  <LatencyDistributionChart entries={filteredEntries} />
                </div>
              </div>
            </CardHeader>
          </Card>
        </div>

        {/* Request History table */}
        <Card className="gap-0 overflow-hidden rounded-lg border-white/[0.06] bg-surface-2 py-0 shadow-none">
          <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Database className="size-4 text-muted-foreground" />
                <CardTitle className="text-sm font-semibold text-foreground">Request History</CardTitle>
                <Badge variant="outline" className="border-white/[0.06] bg-white/[0.02] text-muted-foreground">
                  {filteredEntries.length} visible
                </Badge>
                <Badge variant="outline" className="border-white/[0.08] bg-surface-2 text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" />
                  Success {formatPercent(metrics.successShare)}
                </Badge>
                <Badge variant="outline" className="border-white/[0.08] bg-surface-2 text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-info" />
                  Cloud {formatPercent(metrics.cloudShare)}
                </Badge>
                <Badge variant="outline" className="border-white/[0.08] bg-surface-2 text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-warning" />
                  Fallback {formatPercent(metrics.fallbackShare)}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedIds.size > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 border-danger-muted/50 bg-danger-muted/20 text-danger-fg shadow-none transition-colors hover:bg-danger-muted/40"
                    onClick={confirmDeleteSelected}
                    disabled={deleting}
                  >
                    <Trash2 className="size-3" />
                    Delete {selectedIds.size} selected
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 border-danger-muted/50 bg-danger-muted/20 text-danger-fg shadow-none transition-colors hover:bg-danger-muted/40"
                  onClick={() => {
                    setDeleteFilter("today")
                    setShowDeleteDialog(true)
                  }}
                >
                  <Trash2 className="size-3" />
                  Delete History
                </Button>
              </div>
            </div>

            {/* Active filter chips */}
            {activeFilters.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Active</span>
                {activeFilters.map((filter) => (
                  <Badge
                    key={filter.key}
                    variant="secondary"
                    className="cursor-pointer gap-1 border-white/[0.06] bg-white/[0.06] text-foreground transition-colors hover:bg-white/[0.12]"
                    onClick={filter.clear}
                  >
                    {filter.label}
                    <X className="size-3" />
                  </Badge>
                ))}
                <button
                  type="button"
                  className="ml-auto text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  onClick={clearAllFilters}
                >
                  Clear all
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
              <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Saved views</span>
              <Button variant="outline" size="sm" className="h-7 bg-surface-1 text-xs" onClick={() => applySavedView("errors")}>5xx errors</Button>
              <Button variant="outline" size="sm" className="h-7 bg-surface-1 text-xs" onClick={() => applySavedView("fallbacks")}>Fallbacks</Button>
              <Button variant="outline" size="sm" className="h-7 bg-surface-1 text-xs" onClick={() => applySavedView("slow")}>Slow requests</Button>
            </div>

            <FilterBar
              dateRange={dateRange}
              setDateRange={setDateRange}
              dayFilter={dayFilter}
              setDayFilter={setDayFilter}
              monthFilter={monthFilter}
              setMonthFilter={setMonthFilter}
              yearFilter={yearFilter}
              setYearFilter={setYearFilter}
              backendFilter={backendFilter}
              setBackendFilter={setBackendFilter}
              fallbackOnly={fallbackOnly}
              setFallbackOnly={setFallbackOnly}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              userFilter={userFilter}
              setUserFilter={setUserFilter}
              users={users}
              onChange={() => setCurrentPage(1)}
            />
          </CardHeader>

          {loading ? (
            <TableSkeleton rowCount={8} />
          ) : filteredEntries.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[1220px]">
                  <TableHeader>
                    <TableRow className="border-b border-white/[0.06] bg-surface-3 hover:bg-surface-3">
                      <TableHead className="w-10 pl-5">
                        <Checkbox
                          checked={allVisibleSelected}
                          onChange={toggleVisibleSelection}
                          aria-label="Select all logs on this page"
                        />
                      </TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Time</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Method</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Path</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Mode</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Backend</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Fallback</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Reason</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">Status</TableHead>
                      <TableHead className="text-right text-xs font-semibold text-foreground">Latency</TableHead>
                      <TableHead className="text-xs font-semibold text-foreground">User</TableHead>
                      <TableHead className="pr-5 text-xs font-semibold text-foreground">Target URL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedEntries.map((entry) => (
                      <LogTableRow
                        key={entry.id}
                        entry={entry}
                        users={users}
                        onSelect={setSelectedEntry}
                        selected={selectedIds.has(entry.id)}
                        onToggleSelect={toggleEntrySelection}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-col gap-3 border-t border-white/[0.06] bg-surface-1 px-5 py-3 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
                <div className="font-mono text-xs">
                  Showing{" "}
                  <span className="font-medium text-foreground">{filteredEntries.length ? pageStart + 1 : 0}-{pageEnd}</span>
                  {" "}of{" "}
                  <span className="font-medium text-foreground">{filteredEntries.length}</span>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2">
                    <span>Rows</span>
                    <Select
                      value={String(pageSize)}
                      onValueChange={(v) => {
                        setPageSize(Number(v))
                        setCurrentPage(1)
                      }}
                    >
                      <SelectTrigger className="h-8 w-[4.5rem] bg-surface-3 text-sm font-medium">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {pageSizeOptions.map((option) => (
                          <SelectItem key={option} value={String(option)}>{option}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>

                  <div className="flex items-center gap-2">
                    <span className="min-w-20 text-center font-mono text-xs">
                      Page <span className="font-medium text-foreground">{visiblePage}</span> / {pageCount}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={visiblePage <= 1}
                      className="border-white/[0.08] bg-surface-3 text-foreground shadow-none transition-colors hover:bg-surface-4"
                      onClick={() => setCurrentPage(Math.max(1, visiblePage - 1))}
                    >
                      <ChevronLeft className="size-4" /> Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={visiblePage >= pageCount}
                      className="border-white/[0.08] bg-surface-3 text-foreground shadow-none transition-colors hover:bg-surface-4"
                      onClick={() => setCurrentPage(Math.min(pageCount, visiblePage + 1))}
                    >
                      Next <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 px-6 text-center animate-fade-in">
              <div className="rounded-full border border-white/[0.06] bg-white/[0.02] p-4 text-muted-foreground">
                <Activity className="size-6" />
              </div>
              <div className="font-medium text-foreground">No matching requests</div>
              <p className="max-w-md text-sm text-muted-foreground">
                Adjust the filters or wait for new gateway traffic to appear.
              </p>
            </div>
          )}
        </Card>
      </section>

      <AuditDetailDrawer
        entry={selectedEntry}
        users={users}
        copiedField={copiedField}
        onCopy={handleCopyDetailValue}
        onClose={closeAuditDrawer}
        onDelete={() => selectedEntry && confirmDeleteEntry(selectedEntry)}
      />
      {confirmDialog}

      <DeleteHistoryDialog
        open={showDeleteDialog}
        filter={deleteFilter}
        setFilter={setDeleteFilter}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={() => void handleDeleteHistory()}
        deleting={deleting}
      />

    </main>
  )
}
