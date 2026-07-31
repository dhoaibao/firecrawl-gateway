import { type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

interface PageLayoutProps {
  title: string
  icon: LucideIcon
  count?: { filtered: number; total: number }
  actions?: ReactNode
  children: ReactNode
}

export default function PageLayout({
  title,
  icon: Icon,
  count,
  actions,
  children,
}: PageLayoutProps) {
  return (
    <div id="content" className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1680px] px-4 py-4 lg:px-6">
        <header className="mb-6 flex flex-col gap-4 border-b border-white/[0.06] pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-surface-3 text-muted-foreground">
              <Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                {count && (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {count.filtered} of {count.total}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">Manage your gateway workspace</p>
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
        </header>

        {children}
      </div>
    </div>
  )
}
