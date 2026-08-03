export interface VirtualizedCreationResponse { body: Buffer; upstreamJobId: string; }

/** Replaces public async IDs while retaining the upstream ID for the account-scoped job record. */
export function virtualizeCreationResponse(body: Buffer, publicJobId: string, publicUrl: string): VirtualizedCreationResponse | null {
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.length > 0) { const upstreamJobId = record.id; record.id = publicJobId; if (typeof record.url === "string") record.url = publicUrl; return { body: Buffer.from(JSON.stringify(record)), upstreamJobId }; }
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const metadata = (data as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const scrapeId = (metadata as Record<string, unknown>).scrapeId;
  if (typeof scrapeId !== "string" || scrapeId.length === 0) return null;
  (metadata as Record<string, unknown>).scrapeId = publicJobId;
  return { body: Buffer.from(JSON.stringify(record)), upstreamJobId: scrapeId };
}
