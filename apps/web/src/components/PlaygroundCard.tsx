import { useState } from "react"
import { SlidersHorizontal, Code } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface PlaygroundCardProps {
  inputSection: React.ReactNode
  toolbarExtras?: React.ReactNode
  advanced?: React.ReactNode
  submitLabel: string
  submitLoadingLabel: string
  loading: boolean
  disabled?: boolean
  onSubmit: (e: React.SubmitEvent<HTMLFormElement>) => void
  onGetCode?: () => void
}

export default function PlaygroundCard({
  inputSection,
  toolbarExtras,
  advanced,
  submitLabel,
  submitLoadingLabel,
  loading,
  disabled,
  onSubmit,
  onGetCode,
}: PlaygroundCardProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  return (
    <Card className="gap-0 overflow-hidden rounded-2xl border-white/[0.06] bg-surface-2 p-0 shadow-[var(--shadow-card)]">
      <form onSubmit={onSubmit}>
        <div className="px-5 py-5">{inputSection}</div>
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] bg-surface-1/50 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAdvancedOpen((v) => !v)}
              className={cn(
                "h-8 gap-1.5 px-2 text-xs",
                advancedOpen && "bg-white/[0.06] text-foreground",
              )}
            >
              <SlidersHorizontal className="size-4" />
              <span className="hidden sm:inline">Options</span>
            </Button>
            {toolbarExtras}
          </div>
          <div className="flex items-center gap-2">
            {onGetCode && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onGetCode}
                className="h-8 gap-1.5 px-2 text-xs"
              >
                <Code className="size-4" />
                <span className="hidden sm:inline">Get code</span>
              </Button>
            )}
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={loading || disabled}
              className="h-8 px-4 text-xs font-semibold"
            >
              {loading ? submitLoadingLabel : submitLabel}
            </Button>
          </div>
        </div>
        {advancedOpen && advanced && (
          <div className="border-t border-white/[0.06] bg-surface-1/30 px-5 py-4">
            <div className="grid gap-4 md:grid-cols-2">{advanced}</div>
          </div>
        )}
      </form>
    </Card>
  )
}
