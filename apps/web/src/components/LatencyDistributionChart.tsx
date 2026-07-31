import { useMemo, useState } from "react"

import type { AuditEntry } from "@/types"

interface LatencyDistributionChartProps {
  entries: AuditEntry[]
}

export function LatencyDistributionChart({ entries }: LatencyDistributionChartProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  const buckets = useMemo(() => {
    const result: Record<string, number> = {
      "<500ms": 0,
      "500ms-1s": 0,
      "1s-2s": 0,
      "2s-5s": 0,
      "5s-10s": 0,
      ">10s": 0,
    }
    entries.forEach((entry) => {
      const ms = Number(entry.duration_ms)
      if (!Number.isFinite(ms)) return
      if (ms < 500) result["<500ms"]++
      else if (ms < 1000) result["500ms-1s"]++
      else if (ms < 2000) result["1s-2s"]++
      else if (ms < 5000) result["2s-5s"]++
      else if (ms < 10000) result["5s-10s"]++
      else result[">10s"]++
    })
    return result
  }, [entries])

  const maxCount = Math.max(1, ...Object.values(buckets))
  const total = Object.values(buckets).reduce((sum, c) => sum + c, 0) || 1

  const barMeta = [
    { key: "<500ms", label: "<500ms", gradient: "bg-gradient-to-r from-success/40 to-success", text: "text-success-fg" },
    { key: "500ms-1s", label: "500ms-1s", gradient: "bg-gradient-to-r from-info/40 to-info", text: "text-info-fg" },
    { key: "1s-2s", label: "1s-2s", gradient: "bg-gradient-to-r from-warning/40 to-warning", text: "text-warning-fg" },
    { key: "2s-5s", label: "2s-5s", gradient: "bg-gradient-to-r from-warning/30 to-warning/70", text: "text-warning-fg/70" },
    { key: "5s-10s", label: "5s-10s", gradient: "bg-gradient-to-r from-danger/30 to-danger/70", text: "text-danger-fg/70" },
    { key: ">10s", label: ">10s", gradient: "bg-gradient-to-r from-danger/40 to-danger", text: "text-danger-fg" },
  ] as const

  return (
    <div className="relative h-36 overflow-hidden rounded-lg border border-white/5 bg-surface-2 px-4 py-3">
      {total <= 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          No data
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center gap-2">
          {barMeta.map((bar) => {
            const count = buckets[bar.key]
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
