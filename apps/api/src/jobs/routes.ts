export type AsyncRouteKind = "create" | "lifecycle";

export interface AsyncRoute {
  kind: AsyncRouteKind;
  /** Versioned upstream resource prefix, without its public/upstream ID. */
  family: "/v1/crawl" | "/v2/crawl" | "/v1/batch/scrape" | "/v2/batch/scrape" | "/v1/scrape" | "/v2/scrape" | "/v1/interact" | "/v2/interact";
  publicId?: string;
  suffix: string;
}

const resources = "crawl|batch/scrape|scrape|interact";

/**
 * Identifies the versioned asynchronous resources for which the gateway owns
 * the public ID. The returned suffix is retained when replacing that ID with
 * the upstream ID (for example `/interact` on scrape jobs).
 */
export function classifyAsyncRoute(method: string, pathname: string): AsyncRoute | null {
  const match = pathname.match(new RegExp(`^/(v[12])/(${resources})(?:/([^/]+))?(.*)$`));
  if (!match) return null;
  const [, version, resource, id, suffix] = match;
  const family = `/${version}/${resource}` as AsyncRoute["family"];
  if (method.toUpperCase() === "POST" && !id) return { kind: "create", family, suffix: "" };
  if (!id) return null;

  const normalizedMethod = method.toUpperCase();
  if (resource === "crawl" || resource === "batch/scrape" || resource === "interact") {
    return ["GET", "DELETE"].includes(normalizedMethod)
      ? { kind: "lifecycle", family, publicId: id, suffix }
      : null;
  }
  if (resource === "scrape" && suffix === "/interact" && normalizedMethod === "POST") {
    return { kind: "lifecycle", family, publicId: id, suffix };
  }
  if (resource === "scrape" && (!suffix || suffix === "/") && ["GET", "DELETE"].includes(normalizedMethod)) {
    return { kind: "lifecycle", family, publicId: id, suffix };
  }
  return null;
}

export function replaceAsyncRouteId(route: AsyncRoute, upstreamId: string): string {
  if (route.kind !== "lifecycle") throw new Error("Only lifecycle routes have an ID to replace");
  return `${route.family}/${encodeURIComponent(upstreamId)}${route.suffix}`;
}
