import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { authenticatedUserResponseSchema, errorEnvelopeSchema, type AuthenticatedUser } from "@firecrawl/contracts";
import { API_BASE, csrfFetch } from "@/lib/api";

type AuthUser = AuthenticatedUser;

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  completeMfa: (code: string, recovery?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json());
    if (parsed.success) return new Error(parsed.data.error);
  } catch {
    // Keep authentication errors generic when the server response is malformed.
  }
  return new Error(fallback);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const json: unknown = await res.json();
        setUser(authenticatedUserResponseSchema.parse(json).data);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUser();
  }, [fetchUser]);

  useEffect(() => {
    const handleSessionExpired = () => setUser(null);
    window.addEventListener("gateway:session-expired", handleSessionExpired);
    return () => window.removeEventListener("gateway:session-expired", handleSessionExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await csrfFetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) throw await responseError(res, "Invalid email or password");

    const json = await res.json() as { success?: boolean; mfa_required?: boolean; data?: unknown };
    if (json.mfa_required) return false;
    setUser(authenticatedUserResponseSchema.parse(json).data);
    return true;
  }, []);

  const completeMfa = useCallback(async (code: string, recovery = false) => {
    const res = await csrfFetch(`${API_BASE}/auth/login/mfa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recovery ? { recovery_code: code } : { code }),
    });
    if (!res.ok) throw await responseError(res, "Invalid authentication code");
    const json: unknown = await res.json();
    setUser(authenticatedUserResponseSchema.parse(json).data);
  }, []);

  const logout = useCallback(async () => {
    try {
      await csrfFetch(`${API_BASE}/auth/logout`, { method: "POST" });
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, completeMfa, logout, refresh: fetchUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
