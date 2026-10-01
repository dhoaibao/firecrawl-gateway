import { Check, Clipboard, ExternalLink, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useReturnFocus } from "@/hooks/useReturnFocus";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { formatRelative } from "@/lib/date";
import type { AuditEntry } from "@/types";

interface AuditDetailDrawerProps {
  entry: AuditEntry | null;
  copiedField: string | null;
  onCopy: (field: string, value: string) => void;
  onClose: () => void;
  onDelete: () => void;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 border-b border-white/[0.06] py-3 last:border-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value, window.location.href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function CopyValue({
  field,
  value,
  copiedField,
  onCopy,
}: {
  field: string;
  value: string;
  copiedField: string | null;
  onCopy: (field: string, value: string) => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={() => onCopy(field, value)}
        aria-label={`Copy ${field}`}
      >
        {copiedField === field ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Clipboard className="size-3.5" />
        )}
      </Button>
    </span>
  );
}

export default function AuditDetailDrawer({
  entry,
  copiedField,
  onCopy,
  onClose,
  onDelete,
}: AuditDetailDrawerProps) {
  const returnFocus = useReturnFocus(Boolean(entry));
  const statusVariant =
    !entry || entry.status_code < 400
      ? "success"
      : entry.status_code >= 500
        ? "destructive"
        : "warning";

  return (
    <Sheet
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton
        onCloseAutoFocus={returnFocus}
        className="w-full max-w-xl gap-0 p-0 sm:max-w-xl"
      >
        <header className="border-b border-white/[0.06] bg-surface-3 px-5 py-4 pr-14">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Request details
          </p>
          <SheetTitle className="mt-1 truncate font-mono text-sm font-semibold text-foreground">
            {entry ? `${entry.method} ${entry.path}` : ""}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Audit log details for the selected request.
          </SheetDescription>
        </header>
        {entry && (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge variant={statusVariant}>{entry.status_code}</Badge>
                <Badge variant={entry.fallback_used ? "warning" : "success"}>
                  {entry.fallback_used ? "Fallback used" : "Completed"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {formatRelative(entry.created_at)}
                </span>
              </div>
              <dl>
                <DetailRow label="Request ID">
                  <CopyValue
                    field="request ID"
                    value={entry.id}
                    copiedField={copiedField}
                    onCopy={onCopy}
                  />
                </DetailRow>
                <DetailRow label="Timestamp">
                  {new Date(entry.created_at).toLocaleString()}
                </DetailRow>
                <DetailRow label="Method">
                  <code className="font-mono text-xs">{entry.method}</code>
                </DetailRow>
                <DetailRow label="Path">
                  <CopyValue
                    field="path"
                    value={entry.path}
                    copiedField={copiedField}
                    onCopy={onCopy}
                  />
                </DetailRow>
                <DetailRow label="Route mode">
                  <code className="font-mono text-xs">{entry.route_mode || "—"}</code>
                </DetailRow>
                <DetailRow label="Backend">
                  <Badge variant="outline">{entry.backend_used || "none"}</Badge>
                </DetailRow>
                <DetailRow label="Latency">
                  <span className="font-mono tabular-nums">{Math.round(entry.duration_ms)}ms</span>
                </DetailRow>
                {entry.fallback_reason && (
                  <DetailRow label="Fallback reason">{entry.fallback_reason}</DetailRow>
                )}
                <DetailRow label="Target URL">
                  {entry.target_url ? (
                    isSafeExternalUrl(entry.target_url) ? (
                      <a
                        href={entry.target_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-w-0 items-center gap-2 text-foreground hover:underline"
                        title={entry.target_url}
                      >
                        <code className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-xs">
                          {entry.target_url}
                        </code>
                        <ExternalLink className="size-3.5 shrink-0" />
                      </a>
                    ) : (
                      <code
                        className="block truncate whitespace-nowrap font-mono text-xs text-muted-foreground"
                        title={entry.target_url}
                      >
                        {entry.target_url}
                      </code>
                    )
                  ) : (
                    "—"
                  )}
                </DetailRow>
              </dl>
            </div>
            <footer className="flex justify-end border-t border-white/[0.06] bg-surface-3 px-5 py-4">
              <Button
                variant="destructive"
                size="sm"
                onClick={onDelete}
                aria-label="Delete request log"
              >
                <Trash2 className="size-3.5" /> Delete log
              </Button>
            </footer>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
