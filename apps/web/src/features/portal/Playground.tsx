import { useEffect, useState } from "react"
import { AlertTriangle, Braces, Loader2, Play } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import PageLayout from "@/components/PageLayout"
import { portalApi } from "./api"
import type { QuotaSummary } from "./types"

const DEFAULT_BODY = JSON.stringify({ url: "https://example.com" }, null, 2)

export default function Playground() {
  const [path, setPath] = useState("/v2/scrape")
  const [gatewayToken, setGatewayToken] = useState("")
  const [body, setBody] = useState(DEFAULT_BODY)
  const [quota, setQuota] = useState<QuotaSummary | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    document.title = "Playground — Firecrawl Gateway"
    void portalApi.quota().then((response) => setQuota(response.data)).catch(() => undefined)
  }, [])

  async function run(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedPath = path.startsWith("/") ? path : `/${path}`
    if (!/^\/v[12]\//.test(normalizedPath)) {
      setError("Use a supported /v1/* or /v2/* Firecrawl path.")
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      setError("Request body must be valid JSON.")
      return
    }
    setError("")
    setResult(null)
    setRunning(true)
    try {
      if (!gatewayToken.trim()) {
        setError("Paste a gateway token to authorize this request.")
        return
      }
      setResult(await portalApi.playground(normalizedPath, parsed, gatewayToken.trim()))
      const latest = await portalApi.quota()
      setQuota(latest.data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The playground request failed.")
    } finally {
      setRunning(false)
    }
  }

  return (
    <PageLayout title="Playground" icon={Play}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Card><CardHeader><CardTitle>Run an account-scoped request</CardTitle><CardDescription>The playground uses the same route policy, operation limits, funding preference, and quota pipeline as an external gateway request.</CardDescription></CardHeader><CardContent><form onSubmit={run} className="space-y-4"><label className="block text-sm font-medium" htmlFor="playground-token">Gateway token<Input id="playground-token" className="mt-2 font-mono" type="password" value={gatewayToken} onChange={(event) => setGatewayToken(event.target.value)} autoComplete="off" placeholder="fc_…" required /></label><p className="-mt-2 text-xs text-muted-foreground">The session protects this page; the gateway token still authorizes the request and its scopes. This value is kept only in this page state.</p><label className="block text-sm font-medium" htmlFor="playground-path">Firecrawl path<Input id="playground-path" className="mt-2 font-mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/v2/scrape" /></label><label className="block text-sm font-medium" htmlFor="playground-body">JSON body<textarea id="playground-body" className="mt-2 min-h-48 w-full rounded-lg border border-white/[0.08] bg-surface-3 px-3 py-3 font-mono text-xs text-foreground outline-none transition-all focus:border-ring focus:ring-2 focus:ring-ring/30" value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} /></label>{error && <div className="flex items-start gap-2 rounded-lg border border-danger-muted bg-danger-muted/40 px-3 py-2.5 text-sm text-danger-fg" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</div>}<Button type="submit" disabled={running}>{running ? <Loader2 className="animate-spin" /> : <Play />}{running ? "Running..." : "Run request"}</Button></form></CardContent></Card>
        <div className="space-y-4"><Card><CardHeader><CardTitle className="flex items-center gap-2"><Braces className="size-4 text-info-fg" />Before dispatch</CardTitle><CardDescription>Limits and funding are evaluated before the request is sent.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex items-center justify-between"><span className="text-muted-foreground">Included remaining</span><strong className="font-mono">{quota ? quota.remaining : "—"}</strong></div><div className="flex items-center justify-between"><span className="text-muted-foreground">Funding state</span><Badge variant={quota?.included_traffic_available ? "success" : "warning"}>{quota?.included_traffic_available ? "Included available" : "BYOK or unavailable"}</Badge></div><p className="text-xs leading-relaxed text-muted-foreground">A playground request never receives a trusted shortcut around gateway authorization, quota, privacy, or source limits. A dispatched included request counts once.</p></CardContent></Card>{result !== null && <Card><CardHeader><CardTitle>Response</CardTitle><CardDescription>Provider payloads are displayed only in this page state.</CardDescription></CardHeader><CardContent><pre className="max-h-[28rem] overflow-auto rounded-lg border border-white/[0.06] bg-surface-1 p-4 text-xs leading-relaxed text-muted-foreground"><code>{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</code></pre></CardContent></Card>}</div>
      </div>
    </PageLayout>
  )
}
