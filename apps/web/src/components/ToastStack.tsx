import { AlertCircle, CheckCircle, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Toast } from "@/hooks/useToast"

interface ToastStackProps {
  toasts: Toast[]
  onRemove: (id: number) => void
}

export function ToastStack({ toasts, onRemove }: ToastStackProps) {
  if (toasts.length === 0) return null
  return (
    <div className="fixed left-1/2 top-4 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            "flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg animate-slide-up backdrop-blur",
            toast.type === "error"
              ? "border-danger-muted bg-danger-muted/90 text-danger-fg"
              : "border-success-muted bg-success-muted/90 text-success-fg",
          )}
        >
          {toast.type === "error" ? (
            <AlertCircle className="size-4 shrink-0" />
          ) : (
            <CheckCircle className="size-4 shrink-0" />
          )}
          <span className="text-sm">{toast.message}</span>
          <button
            onClick={() => onRemove(toast.id)}
            type="button"
            className="ml-1 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            aria-label="Dismiss"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
