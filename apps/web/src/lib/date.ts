const DEFAULT_LOCALE = "en-US"

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
}

const shortDateOptions: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "—"
  const d = typeof date === "string" ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString(DEFAULT_LOCALE, dateTimeOptions)
}

export function formatShortDate(date: string | Date | null | undefined): string {
  if (!date) return "—"
  const d = typeof date === "string" ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString(DEFAULT_LOCALE, shortDateOptions)
}

export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return ""
  const d = typeof date === "string" ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return ""

  const now = Date.now()
  const diff = now - d.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString(DEFAULT_LOCALE, { month: "short", day: "numeric" })
}
