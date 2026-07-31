import React from "react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { AuditEntry, UserData } from "@/types"

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info"

function formatTime(value: string): string {
  if (!value) return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function statusVariant(status: number): BadgeVariant {
  if (!Number.isFinite(status)) return "outline"
  if (status < 300) return "success"
  if (status < 500) return "warning"
  return "destructive"
}

function backendVariant(backend: string): BadgeVariant {
  if (backend === "self-hosted") return "success"
  if (backend === "cloud") return "info"
  return "outline"
}

function methodClassName(method: string): string {
  switch (method) {
    case "GET":
      return "border-success-muted bg-success-muted text-success-fg"
    case "POST":
      return "border-info-muted bg-info-muted text-info-fg"
    case "DELETE":
      return "border-danger-muted bg-danger-muted text-danger-fg"
    default:
      return "border-white/10 bg-white/[0.03] text-slate-200"
  }
}

function formatLatency(value: number): string {
  if (!Number.isFinite(value)) return "0ms"
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`
  return `${Math.round(value)}ms`
}

function statusBorderColor(status: number): string {
  if (status >= 200 && status < 400) return "bg-success"
  if (status >= 400 && status < 500) return "bg-warning"
  return "bg-danger"
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

interface LogTableRowProps {
  entry: AuditEntry
  users?: UserData[]
  onSelect?: (entry: AuditEntry) => void
  selected?: boolean
  onToggleSelect?: (id: string) => void
}

export const LogTableRow = React.memo(function LogTableRow({
  entry,
  users,
  onSelect,
  selected = false,
  onToggleSelect,
}: LogTableRowProps) {
  const user = users?.find((u) => u.id === entry.user_id)
  return (
    <TableRow
      className="group cursor-pointer border-white/[0.04] bg-surface-1 transition-colors duration-150 hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => onSelect?.(entry)}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && onSelect) {
          event.preventDefault()
          onSelect(entry)
        }
      }}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `View details for ${entry.method} ${entry.path}` : undefined}
    >
      <TableCell className="pl-5">
        <Checkbox
          checked={selected}
          onChange={() => onToggleSelect?.(entry.id)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          aria-label={`Select log for ${entry.method} ${entry.path}`}
        />
      </TableCell>
      <TableCell className="relative text-xs text-muted-foreground">
        <span
          className={cn(
            "absolute left-0 top-3.5 h-5 w-[3px] rounded-r-full",
            statusBorderColor(entry.status_code),
          )}
        />
        {formatTime(entry.created_at)}
      </TableCell>
      <TableCell>
        <span
          className={cn(
            "inline-flex min-w-14 justify-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium",
            methodClassName(entry.method),
          )}
        >
          {entry.method}
        </span>
      </TableCell>
      <TableCell className="max-w-[280px] whitespace-normal break-all font-mono text-xs font-medium text-foreground">
        {entry.path}
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className="border-white/[0.06] bg-white/[0.02] font-mono text-[11px] text-muted-foreground"
        >
          {entry.route_mode}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge
          variant={backendVariant(entry.backend_used)}
          className="border-white/[0.06]"
        >
          {entry.backend_used || "none"}
        </Badge>
      </TableCell>
      <TableCell>
        {entry.fallback_used ? (
          <Badge
            variant="warning"
            className="border-warning-muted bg-warning-muted text-warning-fg"
          >
            fallback
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">no</span>
        )}
      </TableCell>
      <TableCell className="max-w-[280px] whitespace-normal break-words text-xs text-muted-foreground">
        {entry.fallback_reason || "-"}
      </TableCell>
      <TableCell>
        <Badge
          variant={statusVariant(entry.status_code)}
          className="font-mono text-[11px]"
        >
          {entry.status_code}
        </Badge>
      </TableCell>
      <TableCell className="text-right font-mono text-xs font-medium tabular-nums text-foreground">
        {entry.duration_ms ? formatLatency(entry.duration_ms) : "-"}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {user ? (
          <span className="text-foreground">{user.name || user.email}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="max-w-[320px] overflow-hidden pr-5 font-mono text-xs font-medium">
        {entry.target_url ? (
          isSafeExternalUrl(entry.target_url) ? (
            <a
              href={entry.target_url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="block max-w-[300px] truncate whitespace-nowrap text-foreground underline-offset-4 transition-colors hover:text-white hover:underline"
              title={entry.target_url}
            >
              {entry.target_url}
            </a>
          ) : (
            <span className="block max-w-[300px] truncate whitespace-nowrap text-muted-foreground" title={entry.target_url}>
              {entry.target_url}
            </span>
          )
        ) : (
          <span className="text-muted-foreground">none</span>
        )}
      </TableCell>
    </TableRow>
  )
})
