import { type ReactNode } from "react";
import { cn } from "@firecrawl-gateway/ui/lib/utils";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@firecrawl-gateway/ui/components/table";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  className?: string;
  render: (item: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  emptyState: ReactNode;
  className?: string;
}

export default function DataTable<T>({
  columns,
  data,
  keyExtractor,
  emptyState,
  className,
}: DataTableProps<T>) {
  return (
    <div className={className}>
      <Table>
        <TableHeader>
          <TableRow className="border-white/[0.06] bg-surface-3 hover:bg-surface-3">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(
                  "h-auto px-4 py-3 font-semibold whitespace-normal",
                  col.align === "right" && "text-right",
                  col.align === "center" && "text-center",
                  col.className,
                )}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length > 0 ? (
            data.map((item) => (
              <TableRow
                key={keyExtractor(item)}
                className="group relative border-white/[0.04] hover:bg-white/[0.03]"
              >
                {columns.map((col, colIndex) => (
                  <TableCell
                    key={col.key}
                    className={cn(
                      "px-4 py-3 text-left whitespace-normal",
                      colIndex === 0 && "relative",
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                      col.className,
                    )}
                  >
                    {colIndex === 0 && (
                      <span className="absolute -left-4 top-0 bottom-0 w-[2px] bg-foreground/20 opacity-0 transition-opacity group-hover:opacity-100" />
                    )}
                    {col.render(item)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow className="border-0 hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0 whitespace-normal">
                {emptyState}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
