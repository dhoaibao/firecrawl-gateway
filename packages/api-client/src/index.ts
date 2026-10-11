/** Body of an error response from the gateway API. */
interface ApiErrorBody {
  error?: string;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiClientOptions {
  /** Prefix for relative URLs, without a trailing slash; empty means the page's own origin. */
  baseUrl?: string;
}

type RequestOptions = Omit<RequestInit, "method" | "body">;

async function parseError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return `Request failed with ${response.status}`;
  try {
    const json = (await response.json()) as ApiErrorBody;
    return json.error || `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

/**
 * Creates the fetch wrapper the frontends use to call the gateway API: cookies are
 * always sent (`credentials: "include"`), JSON is the default, and any non-2xx
 * answer rejects with an `ApiError` carrying the API's `error` message.
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");

  function apiUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return `${baseUrl}${url.startsWith("/") ? url : `/${url}`}`;
  }

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(apiUrl(url), {
      ...init,
      credentials: "include",
      headers: { Accept: "application/json", ...(init?.headers || {}) },
    });

    if (!res.ok) throw new ApiError(await parseError(res), res.status);
    return (await res.json()) as T;
  }

  function withJsonBody(method: string, body: unknown, init?: RequestOptions): RequestInit {
    return {
      ...init,
      method,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      body: JSON.stringify(body),
    };
  }

  const api = {
    get<T>(url: string, init?: RequestOptions): Promise<T> {
      return request<T>(url, { ...init, method: "GET" });
    },
    post<T>(url: string, body: unknown, init?: RequestOptions): Promise<T> {
      return request<T>(url, withJsonBody("POST", body, init));
    },
    put<T>(url: string, body: unknown, init?: RequestOptions): Promise<T> {
      return request<T>(url, withJsonBody("PUT", body, init));
    },
    patch<T>(url: string, body: unknown, init?: RequestOptions): Promise<T> {
      return request<T>(url, withJsonBody("PATCH", body, init));
    },
    delete<T>(url: string, body?: unknown, init?: RequestOptions): Promise<T> {
      return request<T>(url, {
        ...init,
        method: "DELETE",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
              body: JSON.stringify(body),
            }),
      });
    },
  };

  return { api, apiUrl };
}
