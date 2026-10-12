import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CircleCheck, Circle } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { ApiKey, CloudKey, Usage } from "@/lib/types";
import { useAuth } from "@/contexts/AuthContext";
import { useResource } from "@/hooks/useResource";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { LoadError, LoadingRows } from "@/components/StateViews";

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-2 px-4 py-3.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function Overview() {
  const { user } = useAuth();
  const usage = useResource<Usage>(
    `/portal/api/usage?range=month&tz=${encodeURIComponent(TIME_ZONE)}`,
  );
  const cloudKeys = useResource<CloudKey[]>("/portal/api/cloud-keys");
  const apiKeys = useResource<ApiKey[]>("/portal/api/api-keys");

  useEffect(() => {
    document.title = "Overview — Firecrawl Gateway";
  }, []);

  const gateway = API_BASE_URL || "https://YOUR-GATEWAY-ORIGIN";
  const snippet = `curl -X POST ${gateway}/v2/scrape \\
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'`;

  const steps = [
    {
      done: (cloudKeys.data?.length ?? 0) > 0,
      known: cloudKeys.data !== null,
      title: "Add a Firecrawl Cloud key",
      detail: "Requests run on your own Firecrawl account and credits.",
      to: "/cloud-keys",
    },
    {
      done: (apiKeys.data?.length ?? 0) > 0,
      known: apiKeys.data !== null,
      title: "Create a gateway API key",
      detail: "Send it as a Bearer token to the gateway instead of your Firecrawl key.",
      to: "/api-keys",
    },
    {
      done: (usage.data?.total ?? 0) > 0,
      known: usage.data !== null,
      title: "Send your first request",
      detail: "It shows up in the usage below within a few seconds.",
      to: null,
    },
  ];
  const allDone = steps.every((step) => step.known && step.done);

  return (
    <>
      <PageHeader
        title={user?.name ? `Hello, ${user.name.split(" ")[0]}` : "Overview"}
        description="Your gateway keys, Cloud keys and request usage this month."
      />

      {!allDone && (
        <section aria-labelledby="getting-started" className="mb-8">
          <h2 id="getting-started" className="mb-3 text-sm font-semibold">
            Get started
          </h2>
          <ol className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.06] bg-surface-2">
            {steps.map((step) => {
              const content = (
                <>
                  {step.done ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {step.title}
                      {step.done && <span className="sr-only"> (done)</span>}
                    </span>
                    <span className="block text-xs text-muted-foreground">{step.detail}</span>
                  </span>
                  {step.to && !step.done && (
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                </>
              );
              return (
                <li key={step.title}>
                  {step.to && !step.done ? (
                    <Link
                      to={step.to}
                      className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.03]"
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className="flex items-start gap-3 px-4 py-3.5">{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section aria-labelledby="usage" className="mb-8">
        <h2 id="usage" className="mb-3 text-sm font-semibold">
          Usage this month
        </h2>
        {usage.loading && !usage.data ? (
          <LoadingRows rows={2} />
        ) : usage.error ? (
          <LoadError message={usage.error} onRetry={usage.reload} />
        ) : usage.data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Requests" value={formatNumber(usage.data.total)} />
              <Metric
                label="Errors"
                value={formatNumber(usage.data.error_count)}
                hint={
                  usage.data.total
                    ? `${((usage.data.error_count / usage.data.total) * 100).toFixed(1)}% of requests`
                    : undefined
                }
              />
              <Metric
                label="Average latency"
                value={`${formatNumber(usage.data.avg_duration_ms)} ms`}
              />
            </div>
            {usage.data.keys.length > 0 && (
              <div className="mt-4 overflow-x-auto rounded-xl border border-white/[0.06] bg-surface-2">
                <table className="w-full min-w-[32rem] text-sm">
                  <caption className="sr-only">Requests per API key this month</caption>
                  <thead>
                    <tr className="bg-surface-3 text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Key
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        Requests
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        Errors
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        Avg latency
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        Last request
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {usage.data.keys.map((key) => (
                      <tr key={key.api_key_id}>
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{key.name}</span>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            {key.key_prefix}…
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                          {formatNumber(key.total)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                          {formatNumber(key.error_count)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                          {key.total ? `${formatNumber(key.avg_duration_ms)} ms` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                          {key.last_request_at ? formatDateTime(key.last_request_at) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              Counts come from the request log, which keeps the last 30 days.
            </p>
          </>
        ) : null}
      </section>

      <section aria-labelledby="quickstart">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="quickstart" className="text-sm font-semibold">
            Quick start
          </h2>
          <CopyButton value={snippet} label="Copy example" variant="ghost" />
        </div>
        <pre className="overflow-x-auto rounded-xl border border-white/[0.06] bg-surface-1 p-4 font-mono text-xs leading-relaxed text-foreground">
          {snippet}
        </pre>
      </section>
    </>
  );
}
