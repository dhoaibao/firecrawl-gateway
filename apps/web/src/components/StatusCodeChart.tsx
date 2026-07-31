import { useMemo, useState } from "react"

import type { AuditEntry } from "@/types"

interface StatusCodeChartProps {
  entries: AuditEntry[]
}

export function StatusCodeChart({ entries }: StatusCodeChartProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  const groups = useMemo(() => {
    const counts: Record<string, number> = {
      "2xx": 0,
      "3xx": 0,
      "4xx": 0,
      "5xx": 0,
      other: 0,
    }
    entries.forEach((entry) => {
      const sc = entry.status_code
      if (sc >= 200 && sc < 300) counts["2xx"]++
      else if (sc >= 300 && sc < 400) counts["3xx"]++
      else if (sc >= 400 && sc < 500) counts["4xx"]++
      else if (sc >= 500 && sc < 600) counts["5xx"]++
      else counts["other"]++
    })
    return counts
  }, [entries])

  const total = entries.length || 1
  const maxCount = Math.max(1, ...Object.values(groups))

  const bars = [
    { key: "2xx", label: "2xx Success", gradient: "bg-gradient-to-r from-success/40 to-success", text: "text-success-fg" },
    { key: "3xx", label: "3xx Redirect", gradient: "bg-gradient-to-r from-info/40 to-info", text: "text-info-fg" },
    { key: "4xx", label: "4xx Client Error", gradient: "bg-gradient-to-r from-warning/40 to-warning", text: "text-warning-fg" },
    { key: "5xx", label: "5xx Server Error", gradient: "bg-gradient-to-r from-danger/40 to-danger", text: "text-danger-fg" },
    { key: "other", label: "Other", gradient: "bg-gradient-to-r from-muted-foreground/40 to-muted-foreground", text: "text-muted-foreground" },
  ] as const

  return (
    <div className="relative h-36 overflow-hidden rounded-lg border border-white/5 bg-surface-2 px-4 py-3">
      {total <= 1 && entries.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          No data
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center gap-2">
          {bars.map((bar) => {
            const count = groups[bar.key]
            const pct = Math.round((count / total) * 100)
            const width = Math.max(count ? 4 : 0, (count / maxCount) * 100)
            const isHovered = hovered === bar.key

            return (
              <div
                key={bar.key}
                className="flex items-center gap-2 rounded-md"
                onMouseEnter={() => setHovered(bar.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="w-20 shrink-0 text-[10px] text-muted-foreground">
                  {bar.label}
                </span>
                <div className="relative h-4 flex-1 rounded-md bg-white/[0.04]">
                  <div
                    className={`h-full rounded-md ${bar.gradient} transition-all duration-300 ${isHovered ? "opacity-100" : "opacity-85"}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
                <span className={`w-12 shrink-0 text-right text-[10px] font-medium ${bar.text}`}>
                  {count} ({pct}%)
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
