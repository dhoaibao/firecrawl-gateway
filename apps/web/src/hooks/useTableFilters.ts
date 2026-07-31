import { useState, useMemo, useCallback } from "react"

export interface FilterState<T> {
  searchQuery: string
  setSearchQuery: (value: string) => void

  page: number
  setPage: (value: number) => void

  pageSize: number
  setPageSize: (value: number) => void

  filteredData: T[]
  paginatedData: T[]

  totalPages: number
  totalItems: number

  resetFilters: () => void
}

interface UseTableFiltersOptions<T> {
  data: T[]
  pageSize?: number
  searchFields?: Array<keyof T>
  filterFn?: (item: T) => boolean
}

export function useTableFilters<T>({
  data,
  pageSize: initialPageSize = 10,
  searchFields,
  filterFn,
}: UseTableFiltersOptions<T>): FilterState<T> {
  const [searchQuery, setSearchQueryState] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeState] = useState(initialPageSize)

  // Reset page when search query changes to avoid landing on an empty page.
  const setSearchQuery = useCallback((value: string) => {
    setSearchQueryState(value)
    setPage(1)
  }, [])

  // Reset page when page size changes because the same page number may no longer exist.
  const setPageSize = useCallback((value: number) => {
    setPageSizeState(value)
    setPage(1)
  }, [])

  const filteredData = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase()

    return data.filter((item) => {
      // Search filter
      if (normalizedSearch && searchFields && searchFields.length > 0) {
        const matches = searchFields.some((field) => {
          const value = item[field]
          if (typeof value === "string") {
            return value.toLowerCase().includes(normalizedSearch)
          }
          return false
        })
        if (!matches) return false
      }

      // Custom filter
      if (filterFn && !filterFn(item)) {
        return false
      }

      return true
    })
  }, [data, searchQuery, searchFields, filterFn])

  const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize))
  const paginatedData = filteredData.slice((page - 1) * pageSize, page * pageSize)

  const resetFilters = () => {
    setSearchQueryState("")
    setPage(1)
  }

  return {
    searchQuery,
    setSearchQuery,
    page,
    setPage,
    pageSize,
    setPageSize,
    filteredData,
    paginatedData,
    totalPages,
    totalItems: filteredData.length,
    resetFilters,
  }
}
