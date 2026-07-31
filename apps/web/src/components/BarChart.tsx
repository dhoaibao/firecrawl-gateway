import { useState } from "react"

export interface BarChartItem {
  key: string
  label: string
  count: number
  gradient?: string
  textColor?: string
}

interface BarChartProps {
  data: BarChartItem[]
  emptyMessage?: string
  labelWidth?: string
  countWidth?: string
}

export default function BarChart({
  data,
  emptyMessage = "No data",
  labelWidth = "w-20",
  countWidth = "w-12",
}: BarChartProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const total = data.reduce((sum, d) => sum + d.count, 0) || 1
  const maxCount = Math.max(1, ...data.map((d) => d.count))

  const defaultGradient = "bg-gradient-to-r from-info/40 to-info"
  const defaultText = "text-info-fg"

  if (data.length === 0 || total <= 0) {
    return (
      <div className="relative h-36 overflow-hidden rounded-lg border border-white/5 bg-surface-2 px-4 py-3">
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {emptyMessage}
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-36 overflow-hidden rounded-lg border border-white/5 bg-surface-2 px-4 py-3">
      <div className="flex h-full flex-col justify-center gap-2">
        {data.map((item) => {
          const pct = Math.round((item.count / total) * 100)
          const width = Math.max(item.count ? 4 : 0, (item.count / maxCount) * 100)
          const isHovered = hovered === item.key

          return (
            <div
              key={item.key}
              className="flex items-center gap-2"
              onMouseEnter={() => setHovered(item.key)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className={`${labelWidth} shrink-0 text-[10px] text-muted-foreground`}>
                {item.label}
              </span>
              <div className="relative h-4 flex-1 rounded-md bg-white/[0.04]">
                <div
                  className={`h-full rounded-md ${item.gradient || defaultGradient} transition-all duration-300 ${isHovered ? "opacity-100" : "opacity-85"}`}
                  style={{ width: `${width}%` }}
                />
              </div>
              <span className={`${countWidth} shrink-0 text-right text-[10px] font-medium ${item.textColor || defaultText}`}>
                {item.count} ({pct}%)
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
