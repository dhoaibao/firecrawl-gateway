import type { ApiError } from "@/types";

class ApiErrorClass extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export { ApiErrorClass as ApiError };

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export function apiUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
}

async function parseError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return `Request failed with ${response.status}`;
  try {
    const json = (await response.json()) as ApiError;
    return json.error || `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), {
    ...options,
    credentials: "include",
    headers: { Accept: "application/json", ...(options?.headers || {}) },
  });

  if (!res.ok) throw new ApiErrorClass(await parseError(res), res.status);
  return (await res.json()) as T;
}

export const api = {
  get<T>(url: string, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, { ...options, method: "GET" });
  },
  post<T>(url: string, body: unknown, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
      body: JSON.stringify(body),
    });
  },
  put<T>(url: string, body: unknown, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
      body: JSON.stringify(body),
    });
  },
  patch<T>(url: string, body: unknown, options?: Omit<RequestInit, "method" | "body">): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
      body: JSON.stringify(body),
    });
  },
  delete<T>(
    url: string,
    body?: unknown,
    options?: Omit<RequestInit, "method" | "body">,
  ): Promise<T> {
    return request<T>(url, {
      ...options,
      method: "DELETE",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
            body: JSON.stringify(body),
          }),
    });
  },
};
