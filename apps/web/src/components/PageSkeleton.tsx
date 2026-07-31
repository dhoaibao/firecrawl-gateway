import { Skeleton } from "@/components/ui/skeleton"

interface PageSkeletonProps {
  columns: number
  rows?: number
  hasSearch?: boolean
}

export default function PageSkeleton({
  columns,
  rows = 6,
  hasSearch = true,
}: PageSkeletonProps) {
  return (
    <div className="min-h-screen bg-background text-foreground animate-fade-in">
      <div className="mx-auto max-w-[1680px] px-4 py-4 lg:px-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded" />
            <Skeleton className="h-6 w-24 rounded" />
            <Skeleton className="h-5 w-16 rounded" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-20 rounded-lg" />
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>
        </div>

        {/* Search bar */}
        {hasSearch && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Skeleton className="h-10 w-full max-w-md rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
          </div>
        )}

        {/* Table */}
        <div className="rounded-lg border border-white/[0.06] bg-surface-2 overflow-hidden">
          {/* Table header */}
          <div className="flex h-10 items-center gap-4 border-b border-white/[0.06] bg-surface-3 px-4">
            {Array.from({ length: columns }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-3 flex-1"
                style={{ minWidth: i === 0 ? 140 : 80 }}
              />
            ))}
          </div>

          {/* Table rows */}
          {Array.from({ length: rows }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="flex h-12 items-center gap-4 border-b border-white/[0.04] px-4"
            >
              {Array.from({ length: columns }).map((__, colIdx) => (
                <Skeleton
                  key={colIdx}
                  className="h-3 flex-1"
                  style={{ minWidth: colIdx === 0 ? 140 : 80 }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
