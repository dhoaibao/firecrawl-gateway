import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { authenticatedUserResponseSchema, type AuthenticatedUser } from "@firecrawl/contracts";

type AuthUser = AuthenticatedUser;

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch("/admin/api/auth/me", { credentials: "include" });
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
    // Restore session on mount: standard React pattern for loading authenticated state.
    void fetchUser();
  }, [fetchUser]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/admin/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({ error: "Login failed" }));
      throw new Error(json.error || "Login failed");
    }

    const json: unknown = await res.json();
    setUser(authenticatedUserResponseSchema.parse(json).data);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/admin/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
