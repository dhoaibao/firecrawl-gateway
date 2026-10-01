import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Pagination as PaginationNav,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

const pageSizeOptions = [10, 25, 50];
const navButtonClass =
  "size-8 border-white/[0.08] bg-surface-3 text-muted-foreground shadow-none hover:bg-surface-4 hover:text-foreground";

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

  const maxVisiblePages = 5;
  const visiblePages: (number | string)[] =
    totalPages <= maxVisiblePages
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : currentPage <= 3
        ? [1, 2, 3, 4, "...", totalPages]
        : currentPage >= totalPages - 2
          ? [1, "...", totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
          : [1, "...", currentPage - 1, currentPage, currentPage + 1, "...", totalPages];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] bg-surface-2 px-4 py-3">
      <div className="text-sm text-muted-foreground" aria-live="polite">
        Showing <span className="font-medium text-foreground">{startItem}</span> -{` `}
        <span className="font-medium text-foreground">{endItem}</span> of{" "}
        <span className="font-medium text-foreground">{totalItems}</span>
      </div>

      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger className="h-8 w-[7rem] bg-surface-3 text-sm" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <PaginationNav className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="outline"
                size="icon"
                className={navButtonClass}
                onClick={() => onPageChange(1)}
                disabled={currentPage <= 1}
                aria-label="First page"
              >
                <ChevronsLeft className="size-4" />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="outline"
                size="icon"
                className={navButtonClass}
                onClick={() => onPageChange(currentPage - 1)}
                disabled={currentPage <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
            </PaginationItem>

            {visiblePages.map((page, idx) =>
              page === "..." ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis className="size-8 text-muted-foreground" />
                </PaginationItem>
              ) : (
                <PaginationItem key={page}>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => onPageChange(page as number)}
                    aria-label={`Page ${page}`}
                    aria-current={currentPage === page ? "page" : undefined}
                    className={cn(
                      "h-8 min-w-8 px-2 text-xs font-medium shadow-none",
                      currentPage === page
                        ? "border-transparent bg-foreground text-background hover:bg-foreground/90 hover:text-background"
                        : "border-white/[0.08] bg-surface-3 text-muted-foreground hover:bg-surface-4 hover:text-foreground",
                    )}
                  >
                    {page}
                  </Button>
                </PaginationItem>
              ),
            )}

            <PaginationItem>
              <Button
                variant="outline"
                size="icon"
                className={navButtonClass}
                onClick={() => onPageChange(currentPage + 1)}
                disabled={currentPage >= totalPages}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="outline"
                size="icon"
                className={navButtonClass}
                onClick={() => onPageChange(totalPages)}
                disabled={currentPage >= totalPages}
                aria-label="Last page"
              >
                <ChevronsRight className="size-4" />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </PaginationNav>
      </div>
    </div>
  );
}
