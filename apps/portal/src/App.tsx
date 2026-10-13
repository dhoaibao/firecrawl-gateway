import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { AppShell } from "@/components/AppShell";
import { LoadingRows } from "@/components/StateViews";
import { PROVIDER_LABELS } from "@/lib/format";

const Login = lazy(() => import("@/pages/Login"));
const Overview = lazy(() => import("@/pages/Overview"));
const ApiKeys = lazy(() => import("@/pages/ApiKeys"));
const CloudKeys = lazy(() => import("@/pages/CloudKeys"));
const Account = lazy(() => import("@/pages/Account"));

function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <LoadingRows />
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** The API redirects back to `/?linked=<provider>` after a successful link. */
function LinkedNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const { addToast } = useToast();
  useEffect(() => {
    const linked = new URLSearchParams(location.search).get("linked");
    if (!linked) return;
    addToast(`${PROVIDER_LABELS[linked] ?? "Sign-in method"} linked to your account`, "success");
    navigate("/account", { replace: true });
  }, [location.search, addToast, navigate]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <LinkedNotice />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Overview />} />
            <Route path="/api-keys" element={<ApiKeys />} />
            <Route path="/cloud-keys" element={<CloudKeys />} />
            <Route path="/account" element={<Account />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
