import { cn } from "@/lib/utils"
import type { LucideIcon } from "lucide-react"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: {
    label: string
    onClick: () => void
  }
  className?: string
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-[320px] flex-col items-center justify-center gap-4 px-6 text-center animate-fade-in",
        className,
      )}
    >
      <div className="relative flex size-14 items-center justify-center rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.06] to-white/[0.02] shadow-[var(--shadow-card)]">
        <Icon className="size-6 text-muted-foreground" />
        <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-info/5 to-transparent" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-all hover:bg-foreground/90 active:translate-y-px"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
