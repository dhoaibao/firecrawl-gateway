import { useEffect, useId, useRef, type ReactNode } from "react"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"

interface DialogProps {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}

export function Dialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const previouslyFocusedRef = useRef<Element | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return

    previouslyFocusedRef.current = document.activeElement
    const focusTimer = window.setTimeout(() => {
      const firstField = dialogRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )
      ;(firstField || firstFocusable || closeButtonRef.current)?.focus()
    }, 0)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== "Tab" || !dialogRef.current) return

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener("keydown", handleKeyDown)
      if (previouslyFocusedRef.current instanceof HTMLElement) {
        previouslyFocusedRef.current.focus()
      }
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm animate-fade-in"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-white/[0.08] bg-surface-2 shadow-[var(--shadow-modal)] animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.06] bg-surface-3 px-5 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-foreground">{title}</h2>
            {description && <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          <Button ref={closeButtonRef} variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label="Close dialog">
            <X className="size-4" />
          </Button>
        </header>
        <div className="px-5 py-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-white/[0.06] bg-surface-1 px-5 py-4">{footer}</footer>}
      </div>
    </div>
  )
}
