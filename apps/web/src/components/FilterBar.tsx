import { CalendarDays, Server, Activity, User, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { BackendFilter, StatusFilter, DateRange, UserData } from "@/types"

const backendFilters: Array<{ label: string; value: BackendFilter }> = [
  { label: "All", value: "" },
  { label: "Self-hosted", value: "self-hosted" },
  { label: "Cloud", value: "cloud" },
]

const statusFilters: Array<{ label: string; value: StatusFilter }> = [
  { label: "All status", value: "" },
  { label: "2xx", value: "2xx" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" },
]

const datePresets: Array<{ label: string; value: DateRange }> = [
  { label: "All", value: "all" },
  { label: "Today", value: "today" },
  { label: "This Week", value: "week" },
  { label: "This Month", value: "month" },
]

interface FilterBarProps {
  dateRange: DateRange
  setDateRange: (value: DateRange) => void
  dayFilter: string
  setDayFilter: (value: string) => void
  monthFilter: string
  setMonthFilter: (value: string) => void
  yearFilter: string
  setYearFilter: (value: string) => void
  backendFilter: BackendFilter
  setBackendFilter: (value: BackendFilter) => void
  fallbackOnly: boolean
  setFallbackOnly: (value: boolean) => void
  statusFilter: StatusFilter
  setStatusFilter: (value: StatusFilter) => void
  userFilter: string
  setUserFilter: (value: string) => void
  users: UserData[]
  onChange: () => void
}

export default function FilterBar({
  dateRange,
  setDateRange,
  dayFilter,
  setDayFilter,
  monthFilter,
  setMonthFilter,
  yearFilter,
  setYearFilter,
  backendFilter,
  setBackendFilter,
  fallbackOnly,
  setFallbackOnly,
  statusFilter,
  setStatusFilter,
  userFilter,
  setUserFilter,
  users,
  onChange,
}: FilterBarProps) {
  return (
    <div className="grid grid-cols-1 gap-5 border-t border-white/[0.06] pt-3 md:grid-cols-2 lg:grid-cols-4">
      {/* Period */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <CalendarDays className="size-3" /> Period
        </label>
        <div className="flex flex-wrap gap-1">
          {datePresets.map((preset) => (
            <Button
              key={preset.value}
              variant={dateRange === preset.value ? "default" : "outline"}
              size="sm"
              className={cn(
                "h-6 border-white/[0.08] px-2.5 text-[11px] shadow-none transition-colors",
                dateRange === preset.value
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-surface-1 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
              onClick={() => {
                setDateRange(preset.value)
                onChange()
              }}
            >
              {preset.label}
            </Button>
          ))}
          <Button
            variant={dateRange === "custom" ? "default" : "outline"}
            size="sm"
            className={cn(
              "h-6 border-white/[0.08] px-2.5 text-[11px] shadow-none transition-colors",
              dateRange === "custom"
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-surface-1 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
            onClick={() => {
              setDateRange(dateRange === "custom" ? "all" : "custom")
              onChange()
            }}
          >
            <SlidersHorizontal className="size-2.5" />
            Custom
          </Button>
        </div>
        {dateRange === "custom" && (
          <div className="flex gap-1 pt-0.5">
            <Select
              value={dayFilter}
              onValueChange={(value) => {
                setDayFilter(value)
                onChange()
              }}
            >
              <SelectTrigger className="h-6 w-[4.5rem] text-[11px]">
                <SelectValue placeholder="Day" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All days</SelectItem>
                {Array.from({ length: 31 }, (_, i) => {
                  const d = String(i + 1).padStart(2, "0")
                  return (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            <Select
              value={monthFilter}
              onValueChange={(value) => {
                setMonthFilter(value)
                onChange()
              }}
            >
              <SelectTrigger className="h-6 w-[5.5rem] text-[11px]">
                <SelectValue placeholder="Month" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {[
                  ["01", "Jan"],
                  ["02", "Feb"],
                  ["03", "Mar"],
                  ["04", "Apr"],
                  ["05", "May"],
                  ["06", "Jun"],
                  ["07", "Jul"],
                  ["08", "Aug"],
                  ["09", "Sep"],
                  ["10", "Oct"],
                  ["11", "Nov"],
                  ["12", "Dec"],
                ].map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={yearFilter}
              onValueChange={(value) => {
                setYearFilter(value)
                onChange()
              }}
            >
              <SelectTrigger className="h-6 w-[4.5rem] text-[11px]">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All years</SelectItem>
                {Array.from({ length: 5 }, (_, i) => {
                  const y = String(new Date().getFullYear() - i)
                  return (
                    <SelectItem key={y} value={y}>
                      {y}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Backend */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Server className="size-3" /> Backend
        </label>
        <div className="flex flex-wrap gap-1">
          {backendFilters.map((filter) => (
            <Button
              key={filter.label}
              variant={
                backendFilter === filter.value && !fallbackOnly
                  ? "default"
                  : "outline"
              }
              size="sm"
              className={cn(
                "h-6 border-white/[0.08] px-2.5 text-[11px] shadow-none transition-colors",
                backendFilter === filter.value && !fallbackOnly
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-surface-1 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
              onClick={() => {
                setBackendFilter(filter.value)
                setFallbackOnly(false)
                onChange()
              }}
            >
              {filter.label}
            </Button>
          ))}
          <Button
            variant={fallbackOnly ? "default" : "outline"}
            size="sm"
            className={cn(
              "h-6 border-white/[0.08] px-2.5 text-[11px] shadow-none transition-colors",
              fallbackOnly
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-surface-1 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
            onClick={() => {
              setFallbackOnly(!fallbackOnly)
              setBackendFilter("")
              onChange()
            }}
          >
            Fallback
          </Button>
        </div>
      </div>

      {/* Status */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Activity className="size-3" /> Status
        </label>
        <div className="flex flex-wrap gap-1">
          {statusFilters.map((filter) => (
            <Button
              key={filter.label}
              variant={
                statusFilter === filter.value ? "default" : "outline"
              }
              size="sm"
              className={cn(
                "h-6 border-white/[0.08] px-2.5 text-[11px] shadow-none transition-colors",
                statusFilter === filter.value
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-surface-1 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
              onClick={() => {
                setStatusFilter(filter.value)
                onChange()
              }}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </div>

      {/* User */}
      {users.length > 0 && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <User className="size-3" /> User
          </label>
          <Select
            value={userFilter}
            onValueChange={(value) => {
              setUserFilter(value)
              onChange()
            }}
          >
            <SelectTrigger className="h-6 w-full text-[11px]">
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name || u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
