/** Paths whose query string carries an OAuth authorization code and `state`. */
const REDACTED_QUERY_PREFIX = "/portal/api/auth/";

/** The URL as it may appear in a request log: OAuth callback parameters never do. */
export function redactLoggedUrl(url: string): string {
  const query = url.indexOf("?");
  if (query < 0 || !url.startsWith(REDACTED_QUERY_PREFIX)) return url;
  return `${url.slice(0, query)}?[redacted]`;
}

/**
 * Replacement for Fastify's default `req` log serializer (same fields) that
 * redacts the sign-in query string, so authorization codes are not written to logs.
 */
export function serializeRequestForLog(request: {
  method?: string;
  url?: string;
  host?: string;
  hostname?: string;
  ip?: string;
  socket?: { remotePort?: number };
}) {
  return {
    method: request.method,
    url: redactLoggedUrl(request.url ?? ""),
    host: request.host ?? request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
