import type { ApiError } from "@/types"

class ApiErrorClass extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export { ApiErrorClass as ApiError }

async function parseError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("application/json")) {
    return `Request failed with ${response.status}`
  }
  try {
    const json = (await response.json()) as ApiError
    return json.error || `Request failed with ${response.status}`
  } catch {
    return `Request failed with ${response.status}`
  }
}

let csrfToken: string | null = null

async function getCsrfToken(): Promise<string> {
  if (!csrfToken) {
    const response = await fetch("/admin/api/auth/csrf", { credentials: "include" })
    const json = (await response.json()) as { data?: { token?: string } }
    if (!json.data?.token) throw new Error("Unable to establish CSRF protection")
    csrfToken = json.data.token
  }
  return csrfToken
}

async function isCsrfFailure(response: Response): Promise<boolean> {
  if (response.status !== 403 || !response.headers.get("content-type")?.includes("application/json")) return false
  try {
    return ((await response.clone().json()) as ApiError).error === "CSRF validation failed"
  } catch {
    return false
  }
}

export async function csrfFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || "GET").toUpperCase()
  const headers = new Headers(options.headers)
  const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(method)
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
    const message = await parseError(res)
    throw new ApiErrorClass(message, res.status)
  }

  return (await res.json()) as T
}

export async function publicPost<T>(url: string, body: unknown): Promise<T> {
  const response = await csrfFetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new ApiErrorClass(await parseError(response), response.status)
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
