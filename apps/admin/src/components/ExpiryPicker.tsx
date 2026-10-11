import { useState } from "react";
import { CalendarIcon, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Expiry time used when a date is picked without choosing a time: the end of that day. */
const DEFAULT_TIME = "23:59";

interface ExpiryPickerProps {
  id: string;
  /** Local `YYYY-MM-DDTHH:mm`, or "" for no expiry. */
  value: string;
  onChange: (value: string) => void;
}

function splitValue(value: string): { date: string; time: string } {
  const [date = "", time = ""] = value.split("T");
  return { date, time: time || DEFAULT_TIME };
}

/** Local midnight of a `YYYY-MM-DD` string; avoids the UTC shift of `new Date("YYYY-MM-DD")`. */
function parseDate(date: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Optional expiry as a calendar date plus a time of day. The value keeps the same
 * local `YYYY-MM-DDTHH:mm` shape the page already compares and converts, so an
 * untouched field round-trips unchanged.
 */
export function ExpiryPicker({ id, value, onChange }: ExpiryPickerProps) {
  const [open, setOpen] = useState(false);
  // What the time field shows while it is being edited. A native time input reports ""
  // for an incomplete or cleared entry; that must not change the expiry, so only a
  // complete time is emitted and leaving the field restores the committed one.
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const { date, time } = splitValue(value);
  const selected = parseDate(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className="h-10 min-w-0 flex-1 justify-start gap-2 bg-surface-1 px-3 font-normal"
          >
            <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
            {selected ? (
              <span className="truncate">
                {selected.toLocaleDateString(undefined, { dateStyle: "medium" })}
              </span>
            ) : (
              <span className="truncate text-muted-foreground">No expiry</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected ?? today}
            disabled={{ before: today }}
            onSelect={(picked) => {
              if (!picked) return;
              onChange(`${formatDateValue(picked)}T${time}`);
              setOpen(false);
            }}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        step={60}
        aria-label="Expiry time"
        value={date ? (timeDraft ?? time) : ""}
        disabled={!date}
        onChange={(event) => {
          const next = event.target.value;
          setTimeDraft(next);
          if (next) onChange(`${date}T${next}`);
        }}
        onBlur={() => setTimeDraft(null)}
        className="h-10 w-28 shrink-0"
      />
      {date && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove expiry"
          title="Remove expiry"
          onClick={() => onChange("")}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
