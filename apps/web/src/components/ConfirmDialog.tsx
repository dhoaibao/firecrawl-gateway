import { useState, useCallback, useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  useEffect(() => {
    if (isOpen) {
      previouslyFocusedRef.current = document.activeElement;
      // Focus the first focusable element (cancel button) after mount
      const timer = setTimeout(() => {
        const focusable = dialogRef.current?.querySelector<HTMLElement>(
          'button:not([disabled])'
        );
        focusable?.focus();
      }, 0);
      return () => clearTimeout(timer);
    } else {
      // Restore focus
      if (previouslyFocusedRef.current instanceof HTMLElement) {
        previouslyFocusedRef.current.focus();
      }
    }
  }, [isOpen]);

  // Escape key handling
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      // Tab cycling
      if (e.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-white/[0.06] bg-surface-2 p-6 shadow-xl animate-slide-up"
      >
        <div className="flex items-start gap-4">
          <div className={`rounded-full p-2 ${variant === "danger" ? "bg-danger-muted/50" : "bg-warning-muted/50"}`}>
            <AlertTriangle className={`size-5 ${variant === "danger" ? "text-danger-fg" : "text-warning-fg"}`} />
          </div>
          <div className="flex-1">
            <h3 id="confirm-title" className="text-lg font-semibold text-foreground">{title}</h3>
            <p id="confirm-desc" className="mt-1 text-sm text-muted-foreground">{message}</p>
          </div>
          <button
            onClick={onCancel}
            className="rounded-md p-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
            aria-label="Close dialog"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={
              variant === "danger"
                ? "border-danger-muted bg-danger-muted text-danger-fg hover:bg-danger-muted/80"
                : "border-warning-muted bg-warning-muted text-warning-fg hover:bg-warning-muted/80"
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmConfig {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  variant?: "danger" | "warning";
}

export function useConfirmDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [config, setConfig] = useState<ConfirmConfig | null>(null);

  const confirm = useCallback(
    (options: ConfirmConfig) => {
      setConfig(options);
      setIsOpen(true);
    },
    []
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setConfig(null);
  }, []);

  const handleConfirm = useCallback(() => {
    if (config) {
      config.onConfirm();
    }
    close();
  }, [config, close]);

  const dialog = config ? (
    <ConfirmDialog
      isOpen={isOpen}
      title={config.title}
      message={config.message}
      confirmLabel={config.confirmLabel}
      cancelLabel={config.cancelLabel}
      variant={config.variant}
      onConfirm={handleConfirm}
      onCancel={close}
    />
  ) : null;

  return { confirm, dialog };
}
