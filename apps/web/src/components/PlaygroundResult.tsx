import { useState, type ReactNode } from "react"
import { Check, Copy, ChevronDown, ChevronUp, AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface PlaygroundResultProps {
  loading?: boolean
  error?: string | null
  result?: unknown
  className?: string
  children?: ReactNode
}

export default function PlaygroundResult({
  loading,
  error,
  result,
  className,
  children,
}: PlaygroundResultProps) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(true)

  async function handleCopy() {
    if (result === undefined) return
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2)
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!loading && !error && result === undefined) {
    return null
  }

  return (
    <Card className={cn("border-white/[0.06] bg-surface-2 shadow-none", className)}>
      <CardContent className="px-0 py-0">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <div className="flex items-center gap-2">
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">Running...</span>
              </>
            ) : error ? (
              <>
                <AlertCircle className="size-4 text-danger-fg" />
                <span className="text-sm font-medium text-danger-fg">Error</span>
              </>
            ) : children !== undefined ? (
              children
            ) : (
              <>
                <Check className="size-4 text-success-fg" />
                <span className="text-sm font-medium text-foreground">Result</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {!loading && result !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <Check className="size-3.5 mr-1" />
                ) : (
                  <Copy className="size-3.5 mr-1" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setExpanded((v) => !v)}
              disabled={loading}
            >
              {expanded ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
        {expanded && (
          <div className="p-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="rounded-lg border border-danger-muted/30 bg-danger-muted/20 px-4 py-3">
                <p className="text-sm text-danger-fg">{error}</p>
              </div>
            ) : (
              <pre className="max-h-[600px] overflow-auto rounded-lg bg-surface-1 p-4 text-xs font-mono text-foreground">
                {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
