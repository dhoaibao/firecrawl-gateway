import {
  Activity,
  Cloud,
  Clock,
  CreditCard,
  Radio,
  Server,
} from "lucide-react"
import { MetricCard } from "@/components/MetricCard"
import { Skeleton } from "@/components/ui/skeleton"
import { formatPercent, formatLatency } from "@/hooks/useAuditMetrics"
import type { AuditMetrics } from "@/hooks/useAuditMetrics"
import type { CreditUsageItem } from "@/types"

interface MetricsGridProps {
  metrics: AuditMetrics
  loading: boolean
  creditUsage?: CreditUsageItem[]
}

function MetricsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-surface-2 p-5"
        >
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-6 rounded-md" />
          </div>
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-2.5 w-32" />
        </div>
      ))}
    </div>
  )
}

export default function MetricsGrid({ metrics, loading, creditUsage }: MetricsGridProps) {
  if (loading) {
    return <MetricsSkeleton />
  }

  const successfulCreditUsage = (creditUsage ?? []).filter(
    (usage) => !usage.error && typeof usage.remainingCredits === "number",
  )
  const totalRemainingCredits = successfulCreditUsage.reduce(
    (total, usage) => total + (usage.remainingCredits ?? 0),
    0,
  )
  const totalPlanCredits = successfulCreditUsage.reduce(
    (total, usage) => total + (usage.planCredits ?? 0),
    0,
  )

  const creditDetail =
    !creditUsage || creditUsage.length === 0
      ? "No saved API keys"
      : successfulCreditUsage.length > 0 && totalPlanCredits > 0
        ? `of ${totalPlanCredits.toLocaleString()} combined plan credits`
        : `${successfulCreditUsage.length} of ${creditUsage.length} key balances included`

  const cards = [
    {
      label: "Total Requests",
      value: metrics.total,
      detail: `${metrics.total} visible`,
      icon: Activity,
    },
    {
      label: "Success Rate",
      value: formatPercent(metrics.successShare),
      detail: `${metrics.successCount} successful`,
      icon: Radio,
    },
    {
      label: "Self-hosted Requests",
      value: metrics.selfHosted,
      detail: "external instance traffic",
      icon: Server,
    },
    {
      label: "Cloud Traffic",
      value: metrics.cloud,
      detail: `${formatPercent(metrics.cloudShare)} of traffic`,
      icon: Cloud,
    },
    {
      label: "Avg Latency",
      value: formatLatency(metrics.avgDuration),
      detail: `${metrics.fallbacks} fallbacks`,
      icon: Clock,
    },
    {
      label: "Available Credits",
      value:
        !creditUsage || creditUsage.length === 0
          ? "—"
          : totalRemainingCredits.toLocaleString(),
      detail: creditDetail,
      icon: CreditCard,
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 animate-slide-up">
      {cards.map((card) => (
        <MetricCard
          key={card.label}
          label={card.label}
          value={card.value}
          detail={card.detail}
          icon={card.icon}
        />
      ))}
    </div>
  )
}
