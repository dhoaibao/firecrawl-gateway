import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const deleteOptions: Array<{ value: "today" | "week" | "month"; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
]

interface DeleteHistoryDialogProps {
  open: boolean
  filter: "today" | "week" | "month"
  setFilter: (value: "today" | "week" | "month") => void
  onClose: () => void
  onConfirm: () => void
  deleting: boolean
}

export default function DeleteHistoryDialog({
  open,
  filter,
  setFilter,
  onClose,
  onConfirm,
  deleting,
}: DeleteHistoryDialogProps) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-history-title"
    >
      <div className="w-full max-w-sm rounded-lg border border-white/[0.06] bg-surface-2 p-6 shadow-xl animate-slide-up">
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-full bg-danger-muted/50 p-2">
            <Trash2 className="size-5 text-danger-fg" />
          </div>
          <div>
            <h3 id="delete-history-title" className="text-base font-semibold text-foreground">
              Delete History
            </h3>
            <p className="text-xs text-muted-foreground">
              Choose a time range to delete
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          {deleteOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                filter === option.value
                  ? "bg-white/[0.08] text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "size-4 rounded-full border-2",
                  filter === option.value
                    ? "border-foreground bg-foreground"
                    : "border-white/20",
                )}
              >
                {filter === option.value && (
                  <span className="block size-full rounded-full border-2 border-surface-2 bg-foreground" />
                )}
              </span>
              {option.label}
            </button>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-white/[0.08] bg-surface-3 text-foreground shadow-none hover:bg-surface-4"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-danger-muted bg-danger-muted text-danger-fg shadow-none hover:bg-danger-muted/80"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  )
}
