import type { ReactNode } from "react";
import { useReturnFocus } from "@/hooks/useReturnFocus";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface FormDialogProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

export function FormDialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
}: FormDialogProps) {
  const returnFocus = useReturnFocus(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden"
        showCloseButton
        onCloseAutoFocus={returnFocus}
      >
        <DialogHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-4 pr-14 text-left">
          <DialogTitle className="text-base leading-normal text-foreground">{title}</DialogTitle>
          <DialogDescription className={description ? "text-sm" : "sr-only"}>
            {description ?? title}
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 py-5">{children}</div>
        {footer && (
          <DialogFooter className="border-t border-white/[0.06] bg-surface-1 px-5 py-4">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
