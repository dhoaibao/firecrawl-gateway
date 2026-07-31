import { useMemo, useState } from "react"

import type { AuditEntry } from "@/types"

interface TopEndpointsChartProps {
  entries: AuditEntry[]
}

export function TopEndpointsChart({ entries }: TopEndpointsChartProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  const topPaths = useMemo(() => {
    const counts = new Map<string, number>()
    entries.forEach((entry) => {
      counts.set(entry.path, (counts.get(entry.path) || 0) + 1)
    })
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
  }, [entries])

  const maxCount = Math.max(1, ...topPaths.map(([, count]) => count))

  return (
    <div className="relative h-36 overflow-hidden rounded-lg border border-white/5 bg-surface-2 px-4 py-3">
      {topPaths.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          No data
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center gap-2">
          {topPaths.map(([path, count]) => {
            const width = Math.max(count ? 4 : 0, (count / maxCount) * 100)
            const isHovered = hovered === path

            return (
              <div
                key={path}
                className="flex items-center gap-2"
                onMouseEnter={() => setHovered(path)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="w-32 shrink-0 truncate text-[10px] text-muted-foreground font-mono">
                  {path || "/"}
                </span>
                <div className="relative h-4 flex-1 rounded-md bg-white/[0.04]">
                  <div
                    className={`h-full rounded-md bg-gradient-to-r from-info/40 to-info transition-all duration-300 ${isHovered ? "opacity-100" : "opacity-85"}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-[10px] font-medium text-info-fg">
                  {count}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
