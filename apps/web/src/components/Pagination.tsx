import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

export default function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  if (totalPages <= 1 && totalItems <= pageSize) return null;

  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  const pageSizeOptions = [10, 25, 50];

  const maxVisiblePages = 5;
  const visiblePages: (number | string)[] =
    totalPages <= maxVisiblePages
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : currentPage <= 3
        ? [1, 2, 3, 4, '...', totalPages]
        : currentPage >= totalPages - 2
          ? [1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
          : [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-white/[0.06] bg-surface-2">
      <div className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{startItem}</span>
        {" "}-{` `}
        <span className="font-medium text-foreground">{endItem}</span>
        {" "}of{" "}
        <span className="font-medium text-foreground">{totalItems}</span>
      </div>

      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="h-8 rounded-lg border border-white/[0.08] bg-surface-3 px-2 text-sm text-foreground outline-none"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(1)}
            disabled={currentPage <= 1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            title="First page"
          >
            <ChevronsLeft className="size-4" />
          </button>
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            title="Previous page"
          >
            <ChevronLeft className="size-4" />
          </button>

          {visiblePages.map((page, idx) =>
            page === '...' ? (
              <span key={`ellipsis-${idx}`} className="px-1 text-xs text-muted-foreground">...</span>
            ) : (
              <button
                key={page}
                onClick={() => onPageChange(page as number)}
                className={cn(
                  "inline-flex h-8 min-w-[2rem] items-center justify-center rounded-lg border text-xs font-medium transition-all",
                  currentPage === page
                    ? "border-transparent bg-foreground text-background shadow-[var(--shadow-card)]"
                    : "border-white/[0.08] bg-surface-3 text-muted-foreground hover:bg-surface-4 hover:text-foreground",
                )}
              >
                {page}
              </button>
            )
          )}

          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            title="Next page"
          >
            <ChevronRight className="size-4" />
          </button>
          <button
            onClick={() => onPageChange(totalPages)}
            disabled={currentPage >= totalPages}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            title="Last page"
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
