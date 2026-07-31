import { useMemo } from "react"
import type { AuditEntry } from "@/types"

const bucketCount = 24

export interface RequestBucket {
  index: number
  success: number
  error: number
}

export interface AuditMetrics {
  total: number
  selfHosted: number
  cloud: number
  fallbacks: number
  avgDuration: number
  successCount: number
  errorCount: number
  successShare: number
  cloudShare: number
  fallbackShare: number
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%"
  return `${Math.round(value)}%`
}

export function formatLatency(value: number): string {
  if (!Number.isFinite(value)) return "0ms"
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`
  return `${Math.round(value)}ms`
}

export function buildRequestBuckets(entries: AuditEntry[]): RequestBucket[] {
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    index,
    success: 0,
    error: 0,
  }))

  entries.slice(0, 180).forEach((entry, entryIndex) => {
    const bucketIndex =
      bucketCount - 1 - Math.min(bucketCount - 1, Math.floor(entryIndex / 4))
    if (entry.status_code >= 200 && entry.status_code < 400) {
      buckets[bucketIndex].success += 1
    } else {
      buckets[bucketIndex].error += 1
    }
  })

  return buckets
}

export function useAuditMetrics(entries: AuditEntry[]): AuditMetrics {
  return useMemo(() => {
    const total = entries.length
    const selfHosted = entries.filter((e) => e.backend_used === "self-hosted").length
    const cloud = entries.filter((e) => e.backend_used === "cloud").length
    const fallbacks = entries.filter((e) => e.fallback_used).length

    const durations = entries
      .map((e) => Number(e.duration_ms))
      .filter((v) => Number.isFinite(v))
    const avgDuration = durations.length
      ? Math.round(durations.reduce((sum, v) => sum + v, 0) / durations.length)
      : 0

    const successCount = entries.filter(
      (e) => e.status_code >= 200 && e.status_code < 300,
    ).length
    const errorCount = entries.filter((e) => e.status_code >= 400).length
    const successShare = total ? (successCount / total) * 100 : 0
    const cloudShare = total ? (cloud / total) * 100 : 0
    const fallbackShare = total ? (fallbacks / total) * 100 : 0

    return {
      total,
      selfHosted,
      cloud,
      fallbacks,
      avgDuration,
      successCount,
      errorCount,
      successShare,
      cloudShare,
      fallbackShare,
    }
  }, [entries])
}
