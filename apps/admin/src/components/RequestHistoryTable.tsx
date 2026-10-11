import { Activity, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogTableRow } from "@/components/LogTableRow";
import type { AuditEntry } from "@/types";

const pageSizeOptions = [10, 25, 50, 100];

function TableSkeleton({ rowCount = 8 }: { rowCount?: number }) {
  return (
    <>
      <div className="min-w-[1220px]">
        <div className="flex h-10 items-center gap-4 border-b border-white/[0.06] bg-surface-3 px-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-3 flex-1 animate-pulse rounded bg-white/[0.06]"
              style={{ minWidth: i === 0 ? 140 : 80 }}
            />
          ))}
        </div>
        {Array.from({ length: rowCount }).map((_, rowIdx) => (
          <div
            key={rowIdx}
            className="flex h-12 items-center gap-4 border-b border-white/[0.04] bg-surface-1 px-5"
          >
            {Array.from({ length: 10 }).map((__, colIdx) => (
              <div
                key={colIdx}
                className="h-3 flex-1 animate-pulse rounded bg-white/[0.06]"
                style={{ minWidth: colIdx === 0 ? 140 : 80 }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.06] bg-surface-1 px-5 py-3">
        <div className="h-3 w-40 animate-pulse rounded bg-white/[0.06]" />
        <div className="flex items-center gap-3">
          <div className="h-8 w-20 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-8 w-28 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-8 w-28 animate-pulse rounded bg-white/[0.06]" />
        </div>
      </div>
    </>
  );
}

interface RequestHistoryTableProps {
  loading: boolean;
  /** Number of entries matching the active filters, across all pages. */
  totalEntries: number;
  /** The entries on the current page. */
  rows: AuditEntry[];
  /** Zero-based index of the first row on the page and one past the last. */
  pageStart: number;
  pageEnd: number;
  /** One-based current page and the number of pages. */
  visiblePage: number;
  pageCount: number;
  pageSize: number;
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  onToggleVisible: () => void;
  onToggleEntry: (id: string) => void;
  onSelectEntry: (entry: AuditEntry) => void;
  onPageSizeChange: (pageSize: number) => void;
  onPageChange: (page: number) => void;
}

/** The request history table with its loading, empty, and pagination states. */
export function RequestHistoryTable({
  loading,
  totalEntries,
  rows,
  pageStart,
  pageEnd,
  visiblePage,
  pageCount,
  pageSize,
  selectedIds,
  allVisibleSelected,
  onToggleVisible,
  onToggleEntry,
  onSelectEntry,
  onPageSizeChange,
  onPageChange,
}: RequestHistoryTableProps) {
  if (loading) return <TableSkeleton rowCount={8} />;

  if (totalEntries === 0) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 px-6 text-center animate-fade-in">
        <div className="rounded-full border border-white/[0.06] bg-white/[0.02] p-4 text-muted-foreground">
          <Activity className="size-6" />
        </div>
        <div className="font-medium text-foreground">No matching requests</div>
        <p className="max-w-md text-sm text-muted-foreground">
          Adjust the filters or wait for new gateway traffic to appear.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table className="min-w-[1220px]">
          <TableHeader>
            <TableRow className="border-b border-white/[0.06] bg-surface-3 hover:bg-surface-3">
              <TableHead className="w-10 pl-5">
                <Checkbox
                  checked={allVisibleSelected}
                  onChange={onToggleVisible}
                  aria-label="Select all logs on this page"
                />
              </TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Time</TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Method</TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Path</TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Mode</TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Backend</TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Fallback</TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Reason</TableHead>
              <TableHead className="text-xs font-semibold text-foreground">Status</TableHead>
              <TableHead className="text-right text-xs font-semibold text-foreground">
                Latency
              </TableHead>
              <TableHead className="pr-5 text-xs font-semibold text-foreground">
                Target URL
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => (
              <LogTableRow
                key={entry.id}
                entry={entry}
                onSelect={onSelectEntry}
                selected={selectedIds.has(entry.id)}
                onToggleSelect={onToggleEntry}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col gap-3 border-t border-white/[0.06] bg-surface-1 px-5 py-3 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <div className="font-mono text-xs">
          Showing{" "}
          <span className="font-medium text-foreground">
            {totalEntries ? pageStart + 1 : 0}-{pageEnd}
          </span>{" "}
          of <span className="font-medium text-foreground">{totalEntries}</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span>Rows</span>
            <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
              <SelectTrigger className="h-8 w-[4.5rem] bg-surface-3 text-sm font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <div className="flex items-center gap-2">
            <span className="min-w-20 text-center font-mono text-xs">
              Page <span className="font-medium text-foreground">{visiblePage}</span> / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={visiblePage <= 1}
              className="border-white/[0.08] bg-surface-3 text-foreground shadow-none transition-colors hover:bg-surface-4"
              onClick={() => onPageChange(Math.max(1, visiblePage - 1))}
            >
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={visiblePage >= pageCount}
              className="border-white/[0.08] bg-surface-3 text-foreground shadow-none transition-colors hover:bg-surface-4"
              onClick={() => onPageChange(Math.min(pageCount, visiblePage + 1))}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
