import { useEffect, useState } from "react"
import { Check, Copy, ExternalLink, Globe2, LockKeyhole } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import PageLayout from "@/components/PageLayout"
import PageSkeleton from "@/components/PageSkeleton"
import { useToast } from "@/hooks/useToast"
import { portalApi } from "./api"
import type { EndpointView } from "./types"

export default function Endpoint() {
  const [endpoint, setEndpoint] = useState<EndpointView | null>(null)
  const [loading, setLoading] = useState(true)
  const { addToast } = useToast()
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    document.title = "Endpoint — Firecrawl Gateway"
    void portalApi.endpoint().then((response) => setEndpoint(response.data)).catch((error) => addToast(error instanceof Error ? error.message : "Unable to load endpoint", "error")).finally(() => setLoading(false))
  }, [addToast])

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied(null), 2_000)
    } catch {
      addToast("Unable to copy from this browser", "error")
    }
  }

  if (loading || !endpoint) return <PageSkeleton columns={2} rows={5} />
  const baseUrl = `${window.location.origin}${endpoint.base_path}`
  const curl = `curl -X POST '${baseUrl}/v2/scrape' \\\n  -H 'Authorization: Bearer <gateway-token>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"url":"https://example.com"}'`
  const sdk = `from firecrawl import Firecrawl\nclient = Firecrawl(api_key="<gateway-token>", api_url="${baseUrl}")\nclient.scrape("https://example.com")`

  return (
    <PageLayout title="Endpoint" icon={Globe2}>
      <div className="space-y-4">
        <Card><CardHeader><div className="flex items-start justify-between gap-4"><div><CardTitle>Tenant gateway endpoint</CardTitle><CardDescription className="mt-1">This routing identifier is immutable for your workspace.</CardDescription></div><span className="rounded-full bg-success-muted px-2.5 py-1 text-xs text-success-fg">{endpoint.status}</span></div></CardHeader><CardContent className="space-y-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-center"><code className="min-w-0 flex-1 truncate rounded-md border border-white/[0.08] bg-surface-1 px-3 py-2.5 font-mono text-sm">{baseUrl}</code><Button variant="outline" onClick={() => void copy(baseUrl, "endpoint")}>{copied === "endpoint" ? <Check /> : <Copy />} {copied === "endpoint" ? "Copied" : "Copy URL"}</Button></div><div className="flex items-start gap-2 text-xs text-muted-foreground"><LockKeyhole className="mt-0.5 size-4 shrink-0 text-info-fg" /><p>The endpoint ID is safe to share. Every request still needs an active gateway token; never put the token in a URL.</p></div></CardContent></Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card><CardHeader><CardTitle>cURL</CardTitle><CardDescription>Use a token in the Authorization header.</CardDescription></CardHeader><CardContent><pre className="overflow-x-auto rounded-lg border border-white/[0.06] bg-surface-1 p-4 text-xs leading-relaxed text-muted-foreground"><code>{curl}</code></pre><Button variant="outline" size="sm" className="mt-3" onClick={() => void copy(curl, "curl")}>{copied === "curl" ? <Check /> : <Copy />} {copied === "curl" ? "Copied" : "Copy example"}</Button></CardContent></Card>
          <Card><CardHeader><CardTitle>Python SDK</CardTitle><CardDescription>Point your Firecrawl client at this base URL.</CardDescription></CardHeader><CardContent><pre className="overflow-x-auto rounded-lg border border-white/[0.06] bg-surface-1 p-4 text-xs leading-relaxed text-muted-foreground"><code>{sdk}</code></pre><Button variant="outline" size="sm" className="mt-3" onClick={() => void copy(sdk, "sdk")}>{copied === "sdk" ? <Check /> : <Copy />} {copied === "sdk" ? "Copied" : "Copy example"}</Button></CardContent></Card>
        </div>
        <Card className="border-info-muted bg-info-muted/20"><CardContent className="flex items-start gap-3 px-5 py-4 text-sm"><ExternalLink className="mt-0.5 size-4 shrink-0 text-info-fg" /><p className="text-muted-foreground">Supported Firecrawl paths are under <code className="font-mono text-foreground">/v1/*</code> and <code className="font-mono text-foreground">/v2/*</code>. See Tokens for scoped access and expiry controls.</p></CardContent></Card>
      </div>
    </PageLayout>
  )
}
