import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import type { PortalUser } from "@/lib/types";

interface AuthContextValue {
  user: PortalUser | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api
      .get<{ data: PortalUser }>("/portal/api/auth/me")
      .then((json) => active && setUser(json.data))
      .catch((error) => {
        // 401 is the normal signed-out answer; anything else also leaves the user signed out.
        if (!(error instanceof ApiError) || error.status !== 401) console.error(error);
        if (active) setUser(null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  /**
   * Signs out on the server first. The signed-in state is cleared only once the session
   * is really gone (or was already invalid); otherwise the cookie would stay usable
   * behind a signed-out screen, so a failure is thrown for the caller to show.
   */
  const logout = useCallback(async () => {
    try {
      await api.post("/portal/api/auth/logout", {});
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
