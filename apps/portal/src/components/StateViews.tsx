import type { LucideIcon } from "lucide-react";
import { AlertCircle } from "lucide-react";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { Skeleton } from "@firecrawl-gateway/ui/components/skeleton";

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-danger-muted bg-danger-muted/40 px-4 py-3 text-sm text-danger-fg"
    >
      <AlertCircle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

interface EmptyBlockProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyBlock({ icon: Icon, title, description, action }: EmptyBlockProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/[0.1] px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-white/[0.08] bg-surface-3 text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {action && (
        <Button type="button" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
