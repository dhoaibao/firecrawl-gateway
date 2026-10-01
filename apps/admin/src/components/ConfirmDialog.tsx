import { useState, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { useReturnFocus } from "@/hooks/useReturnFocus";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  const danger = variant === "danger";
  const returnFocus = useReturnFocus(isOpen);
  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent className="gap-0" onCloseAutoFocus={returnFocus}>
        <div className="flex items-start gap-4">
          <div
            className={`rounded-full p-2 ${danger ? "bg-danger-muted/50" : "bg-warning-muted/50"}`}
          >
            <AlertTriangle className={`size-5 ${danger ? "text-danger-fg" : "text-warning-fg"}`} />
          </div>
          <div className="flex-1">
            <AlertDialogTitle className="text-lg font-semibold text-foreground">
              {title}
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-1">{message}</AlertDialogDescription>
          </div>
        </div>
        <AlertDialogFooter className="mt-6">
          <AlertDialogCancel size="sm">{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            size="sm"
            className={
              danger
                ? "border-danger-muted bg-danger-muted text-danger-fg hover:bg-danger-muted/80"
                : "border-warning-muted bg-warning-muted text-warning-fg hover:bg-warning-muted/80"
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

  const confirm = useCallback((options: ConfirmConfig) => {
    setConfig(options);
    setIsOpen(true);
  }, []);

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
