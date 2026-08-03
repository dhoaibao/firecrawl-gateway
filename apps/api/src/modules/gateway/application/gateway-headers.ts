const hopByHopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>, backend: string, apiKey?: string, authEnabled = true): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower) || lower === "x-firecrawl-route-mode") continue;
    if (lower === "authorization" && backend !== "cloud" && authEnabled) continue;
    if (value !== undefined) next[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (backend === "cloud" && apiKey) next.authorization = `Bearer ${apiKey}`;
  return next;
}

export function headersForPrivacyCheck(headers: Record<string, string | string[] | undefined>, authEnabled: boolean): Record<string, string | string[] | undefined> {
  if (!authEnabled) return headers;
  const next = { ...headers };
  for (const key of Object.keys(next)) if (key.toLowerCase() === "authorization") delete next[key];
  return next;
}
