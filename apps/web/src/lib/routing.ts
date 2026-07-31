export const DEFAULT_ROUTE_MODE = "cloud-first" as const

export const ROUTE_MODES = [
  { value: "self-hosted-first" as const, label: "Self-hosted first (fallback to cloud)" },
  { value: "self-hosted-only" as const, label: "Self-hosted only" },
  { value: "cloud-first" as const, label: "Cloud first (fallback to self-hosted)" },
  { value: "cloud-only" as const, label: "Cloud only" },
] as const

export type RouteMode = (typeof ROUTE_MODES)[number]["value"]
