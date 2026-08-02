import { errorEnvelopeSchema } from "@firecrawl/contracts"

export const API_BASE = "/api/v1"

export type ContractSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

export function parseContract<T>(schema: ContractSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error("The server returned an invalid response.")
  return parsed.data
}

class ApiErrorClass extends Error {
  status: number
  code?: string
  requestId?: string

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export { ApiErrorClass as ApiError }

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function errorPayload(response: Response): Promise<{ message: string; code?: string }> {
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("application/json")) {
    return { message: `Request failed with ${response.status}` }
  }
  try {
    const json: unknown = await response.clone().json()
    const parsed = errorEnvelopeSchema.safeParse(json)
    if (parsed.success) return { message: parsed.data.error, code: parsed.data.code }
  } catch {
    // Treat malformed server responses as a safe generic error.
  }
  return { message: `Request failed with ${response.status}` }
}

async function toApiError(response: Response): Promise<ApiErrorClass> {
  const payload = await errorPayload(response)
  return new ApiErrorClass(
    payload.message,
    response.status,
    payload.code,
    response.headers.get("x-request-id") || undefined,
  )
}

function notifySessionStatus(url: string, response: Response, message: string, code?: string): void {
  if (response.status === 401 && !url.includes("/auth/login")) {
    window.dispatchEvent(new CustomEvent("gateway:session-expired"))
  }
  if (response.status === 403 && (code === "email_verification_required" || /verification is required/i.test(message))) {
    window.dispatchEvent(new CustomEvent("gateway:verification-required"))
  }
  if (response.status === 403 && (code === "mfa_required" || /mfa is required|operator mfa/i.test(message))) {
    window.dispatchEvent(new CustomEvent("gateway:mfa-required"))
  }
}

let csrfToken: string | null = null

async function getCsrfToken(): Promise<string> {
  if (!csrfToken) {
    const response = await fetch(`${API_BASE}/auth/csrf`, {
      credentials: "include",
      headers: { Accept: "application/json", "X-Request-ID": requestId() },
    })
    if (!response.ok) throw await toApiError(response)
    const json = (await response.json()) as { data?: { token?: string } }
    if (!json.data?.token) throw new Error("Unable to establish CSRF protection")
    csrfToken = json.data.token
  }
  return csrfToken
}

async function isCsrfFailure(response: Response): Promise<boolean> {
  if (response.status !== 403 || !response.headers.get("content-type")?.includes("application/json")) return false
  const payload = await errorPayload(response)
  return payload.message === "CSRF validation failed"
}

export async function csrfFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || "GET").toUpperCase()
  const headers = new Headers(options.headers)
  const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(method)
  headers.set("X-Request-ID", headers.get("X-Request-ID") || requestId())
  if (stateChanging) headers.set("X-CSRF-Token", await getCsrfToken())

  let response = await fetch(url, { ...options, headers, credentials: "include" })
  if (stateChanging && await isCsrfFailure(response)) {
    csrfToken = null
    headers.set("X-CSRF-Token", await getCsrfToken())
    response = await fetch(url, { ...options, headers, credentials: "include" })
  }
  return response
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await csrfFetch(url, {
    ...options,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options?.headers || {}),
    },
  })

  if (!res.ok) {
    const error = await toApiError(res)
    notifySessionStatus(url, res, error.message, error.code)
    throw error
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export async function publicPost<T>(url: string, body: unknown): Promise<T> {
  const response = await csrfFetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const error = await toApiError(response)
    notifySessionStatus(url, response, error.message, error.code)
    throw error
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  get<T>(url: string, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, { ...options, method: "GET" })
  },

  post<T>(url: string, body: unknown, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
      body: JSON.stringify(body),
    })
  },

  put<T>(url: string, body: unknown, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
      body: JSON.stringify(body),
    })
  },

  patch<T>(url: string, body: unknown, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
      body: JSON.stringify(body),
    })
  },

  delete<T>(url: string, body?: unknown, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "DELETE",
      ...(body === undefined
        ? {}
        : {
            headers: {
              "Content-Type": "application/json",
              ...(options?.headers || {}),
            },
            body: JSON.stringify(body),
          }),
    })
  },
}
