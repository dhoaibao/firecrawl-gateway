import { Trash2 } from "lucide-react";
import { useReturnFocus } from "@/hooks/useReturnFocus";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type DeleteFilter = "today" | "week" | "month" | "all";

const deleteOptions: Array<{ value: DeleteFilter; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All History" },
];

interface DeleteHistoryDialogProps {
  open: boolean;
  filter: DeleteFilter;
  setFilter: (value: DeleteFilter) => void;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
}

export default function DeleteHistoryDialog({
  open,
  filter,
  setFilter,
  onClose,
  onConfirm,
  deleting,
}: DeleteHistoryDialogProps) {
  const returnFocus = useReturnFocus(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !deleting) onClose();
      }}
    >
      <DialogContent
        className="max-w-sm gap-0 p-6 sm:max-w-sm"
        showCloseButton={false}
        onCloseAutoFocus={returnFocus}
      >
        <DialogHeader className="mb-4 flex-row items-center gap-3 text-left">
          <div className="rounded-full bg-danger-muted/50 p-2">
            <Trash2 className="size-5 text-danger-fg" />
          </div>
          <div className="flex flex-col gap-0.5">
            <DialogTitle className="text-base leading-normal text-foreground">
              Delete History
            </DialogTitle>
            <DialogDescription className="text-xs">Choose a time range to delete</DialogDescription>
          </div>
        </DialogHeader>

        <ToggleGroup
          type="single"
          orientation="vertical"
          spacing={1}
          value={filter}
          onValueChange={(value) => {
            if (value) setFilter(value as DeleteFilter);
          }}
          aria-label="Time range to delete"
          className="w-full flex-col items-stretch"
        >
          {deleteOptions.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              disabled={deleting}
              className="h-9 w-full justify-start rounded-md px-3 text-sm text-muted-foreground data-[state=on]:bg-white/[0.08] data-[state=on]:text-foreground"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <DialogFooter className="mt-5">
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
