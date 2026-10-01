import { CalendarDays, Server, Activity, SlidersHorizontal } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BackendFilter, StatusFilter, DateRange } from "@/types";

const backendFilters: Array<{ label: string; value: BackendFilter }> = [
  { label: "All", value: "" },
  { label: "Self-hosted", value: "self-hosted" },
  { label: "Cloud", value: "cloud" },
];

const statusFilters: Array<{ label: string; value: StatusFilter }> = [
  { label: "All status", value: "" },
  { label: "2xx", value: "2xx" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" },
];

const datePresets: Array<{ label: string; value: DateRange }> = [
  { label: "All", value: "all" },
  { label: "Today", value: "today" },
  { label: "This Week", value: "week" },
  { label: "This Month", value: "month" },
];

const filterItemClass =
  "h-8 border border-white/[0.08] bg-surface-1 px-3 text-xs font-medium text-muted-foreground shadow-none hover:bg-white/[0.04] hover:text-foreground data-[state=on]:border-transparent data-[state=on]:bg-foreground data-[state=on]:text-background";

interface FilterBarProps {
  dateRange: DateRange;
  setDateRange: (value: DateRange) => void;
  dayFilter: string;
  setDayFilter: (value: string) => void;
  monthFilter: string;
  setMonthFilter: (value: string) => void;
  yearFilter: string;
  setYearFilter: (value: string) => void;
  backendFilter: BackendFilter;
  setBackendFilter: (value: BackendFilter) => void;
  fallbackOnly: boolean;
  setFallbackOnly: (value: boolean) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (value: StatusFilter) => void;
  onChange: () => void;
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
  onChange,
}: FilterBarProps) {
  return (
    <div className="grid grid-cols-1 gap-5 border-t border-white/[0.06] pt-3 md:grid-cols-2 lg:grid-cols-4">
      {/* Period */}
      <div className="space-y-1.5">
        <span
          id="filter-period-label"
          className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          <CalendarDays className="size-3" /> Period
        </span>
        <ToggleGroup
          type="single"
          spacing={1}
          value={dateRange}
          aria-labelledby="filter-period-label"
          className="flex-wrap"
          onValueChange={(value) => {
            if (value) setDateRange(value as DateRange);
            else if (dateRange === "custom") setDateRange("all");
            else return;
            onChange();
          }}
        >
          {datePresets.map((preset) => (
            <ToggleGroupItem key={preset.value} value={preset.value} className={filterItemClass}>
              {preset.label}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value="custom" className={filterItemClass}>
            <SlidersHorizontal className="size-3" />
            Custom
          </ToggleGroupItem>
        </ToggleGroup>
        {dateRange === "custom" && (
          <div className="flex gap-1 pt-0.5">
            <Select
              value={dayFilter}
              onValueChange={(value) => {
                setDayFilter(value);
                onChange();
              }}
            >
              <SelectTrigger className="h-8 w-[4.5rem] text-[11px]">
                <SelectValue placeholder="Day" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All days</SelectItem>
                {Array.from({ length: 31 }, (_, i) => {
                  const d = String(i + 1).padStart(2, "0");
                  return (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Select
              value={monthFilter}
              onValueChange={(value) => {
                setMonthFilter(value);
                onChange();
              }}
            >
              <SelectTrigger className="h-8 w-[5.5rem] text-[11px]">
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
                setYearFilter(value);
                onChange();
              }}
            >
              <SelectTrigger className="h-8 w-[4.5rem] text-[11px]">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All years</SelectItem>
                {Array.from({ length: 5 }, (_, i) => {
                  const y = String(new Date().getFullYear() - i);
                  return (
                    <SelectItem key={y} value={y}>
                      {y}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Backend */}
      <div className="space-y-1.5">
        <span
          id="filter-backend-label"
          className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          <Server className="size-3" /> Backend
        </span>
        <ToggleGroup
          type="single"
          spacing={1}
          value={fallbackOnly ? "fallback" : backendFilter || "all"}
          aria-labelledby="filter-backend-label"
          className="flex-wrap"
          onValueChange={(value) => {
            if (!value) {
              // Clicking the active Fallback again clears it; ordinary backend
              // selections cannot be deselected.
              if (!fallbackOnly) return;
              setFallbackOnly(false);
              setBackendFilter("");
              onChange();
              return;
            }
            if (value === "fallback") {
              setFallbackOnly(true);
              setBackendFilter("");
            } else {
              setBackendFilter(value === "all" ? "" : (value as BackendFilter));
              setFallbackOnly(false);
            }
            onChange();
          }}
        >
          {backendFilters.map((filter) => (
            <ToggleGroupItem
              key={filter.label}
              value={filter.value || "all"}
              className={filterItemClass}
            >
              {filter.label}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value="fallback" className={filterItemClass}>
            Fallback
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Status */}
      <div className="space-y-1.5">
        <span
          id="filter-status-label"
          className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          <Activity className="size-3" /> Status
        </span>
        <ToggleGroup
          type="single"
          spacing={1}
          value={statusFilter || "all"}
          aria-labelledby="filter-status-label"
          className="flex-wrap"
          onValueChange={(value) => {
            if (!value) return;
            setStatusFilter((value === "all" ? "" : value) as StatusFilter);
            onChange();
          }}
        >
          {statusFilters.map((filter) => (
            <ToggleGroupItem
              key={filter.label}
              value={filter.value || "all"}
              className={filterItemClass}
            >
              {filter.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );
}
