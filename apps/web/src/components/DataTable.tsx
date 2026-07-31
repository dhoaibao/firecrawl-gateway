import { type ReactNode } from "react"
import { cn } from "@/lib/utils"

export interface Column<T> {
  key: string
  header: string
  align?: "left" | "right" | "center"
  className?: string
  render: (item: T) => ReactNode
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  keyExtractor: (item: T) => string
  emptyState: ReactNode
  className?: string
}

export default function DataTable<T>({
  columns,
  data,
  keyExtractor,
  emptyState,
  className,
}: DataTableProps<T>) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.06] bg-surface-3">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  "px-4 py-3 text-left font-semibold",
                  col.align === "right" && "text-right",
                  col.align === "center" && "text-center",
                  col.className,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length > 0 ? (
            data.map((item) => (
              <tr
                key={keyExtractor(item)}
                className="group relative border-b border-white/[0.04] transition-colors hover:bg-white/[0.03]"
              >
                {columns.map((col, colIndex) => (
                  <td
                    key={col.key}
                    className={cn(
                      "px-4 py-3 text-left",
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
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>{emptyState}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
