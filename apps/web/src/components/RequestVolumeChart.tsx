import { useState } from "react"

interface Bucket {
  index: number
  success: number
  error: number
}

interface RequestVolumeChartProps {
  buckets: Bucket[]
}

export function RequestVolumeChart({ buckets }: RequestVolumeChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const maxBucketValue = Math.max(
    1,
    ...buckets.map((bucket) => bucket.success + bucket.error),
  )

  return (
    <div className="relative h-36 overflow-hidden rounded-lg border border-white/5 bg-surface-2 px-4 py-3">
      <div className="absolute inset-x-4 top-1/2 border-t border-dashed border-white/10" />
      <div className="absolute inset-x-4 bottom-8 border-t border-dashed border-white/10" />

      {/* Tooltip */}
      {hoveredIndex !== null && (
        <div className="pointer-events-none absolute top-2 right-2 z-10 rounded-md border border-white/10 bg-surface-4 px-2.5 py-1.5 shadow-lg animate-fade-in">
          <div className="flex items-center gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-success-fg">
              <span className="size-1.5 rounded-full bg-success" />
              {buckets[hoveredIndex].success} success
            </span>
            <span className="inline-flex items-center gap-1.5 text-danger-fg">
              <span className="size-1.5 rounded-full bg-danger" />
              {buckets[hoveredIndex].error} error
            </span>
          </div>
        </div>
      )}

      <div className="relative flex h-full items-end gap-1">
        {buckets.map((bucket, i) => {
          const successHeight = Math.max(
            bucket.success ? 10 : 0,
            (bucket.success / maxBucketValue) * 100,
          )
          const errorHeight = Math.max(
            bucket.error ? 10 : 0,
            (bucket.error / maxBucketValue) * 100,
          )
          const delay = i * 20

          return (
            <div
              key={bucket.index}
              className="flex h-full flex-1 items-end justify-center rounded-md"
              onMouseEnter={() => setHoveredIndex(bucket.index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <div className="flex h-full w-full max-w-6 flex-col justify-end gap-0.5 transition-opacity duration-150 hover:opacity-80">
                {bucket.error > 0 ? (
                  <div
                    className="rounded-t-md bg-gradient-to-t from-danger/50 to-danger transition-all duration-300 animate-slide-up"
                    style={{ height: `${errorHeight}%`, animationDelay: `${delay}ms` }}
                  />
                ) : null}
                {bucket.success > 0 ? (
                  <div
                    className="rounded-t-md bg-gradient-to-t from-success/50 to-success transition-all duration-300 animate-slide-up"
                    style={{ height: `${successHeight}%`, animationDelay: `${delay}ms` }}
                  />
                ) : (
                  <div className="h-1 rounded-full bg-white/5" />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
