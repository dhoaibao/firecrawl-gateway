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
} from "@firecrawl-gateway/ui/components/alert-dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const returnFocus = useReturnFocus(open);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent className="gap-0" onCloseAutoFocus={returnFocus}>
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-danger-muted/50 p-2">
            <AlertTriangle className="size-5 text-danger-fg" />
          </div>
          <div className="flex-1">
            <AlertDialogTitle className="text-lg font-semibold text-foreground">
              {title}
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-1">{message}</AlertDialogDescription>
          </div>
        </div>
        <AlertDialogFooter className="mt-6">
          <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            size="sm"
            className="border-danger-muted bg-danger-muted text-danger-fg hover:bg-danger-muted/80"
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
