import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { ToastProvider } from "@/contexts/ToastContext";
import ErrorBoundary from "@/components/ErrorBoundary";
import Sidebar from "@/components/Sidebar";

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Login = lazy(() => import("@/pages/Login"));
const ApiKeys = lazy(() => import("@/pages/ApiKeys"));
const Configure = lazy(() => import("@/pages/Configure"));
const CloudKeys = lazy(() => import("@/pages/CloudKeys"));
const Account = lazy(() => import("@/pages/Account"));

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background animate-fade-in">
      <div className="flex flex-col items-center gap-4">
        <div className="size-10 animate-pulse rounded-xl border border-white/[0.08] bg-surface-2">
          <div className="size-full rounded-xl bg-gradient-to-br from-white/[0.06] to-transparent"></div>
        </div>
        <div className="h-2 w-24 animate-pulse rounded-full bg-white/[0.06]"></div>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { admin, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!admin) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AuthenticatedLayout() {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 pt-14 lg:ml-60 lg:pt-0">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <a href="#content" className="skip-link">
            Skip to content
          </a>
          <Routes>
            <Route
              path="/login"
              element={
                <Suspense fallback={<LoadingScreen />}>
                  <Login />
                </Suspense>
              }
            />
            <Route
              element={
                <RequireAuth>
                  <AuthenticatedLayout />
                </RequireAuth>
              }
            >
              <Route
                path="/"
                element={
                  <Suspense fallback={<LoadingScreen />}>
                    <Dashboard />
                  </Suspense>
                }
              />
              <Route
                path="/api-keys"
                element={
                  <Suspense fallback={<LoadingScreen />}>
                    <ApiKeys />
                  </Suspense>
                }
              />
              <Route
                path="/cloud-keys"
                element={
                  <Suspense fallback={<LoadingScreen />}>
                    <CloudKeys />
                  </Suspense>
                }
              />
              <Route
                path="/configure"
                element={
                  <Suspense fallback={<LoadingScreen />}>
                    <Configure />
                  </Suspense>
                }
              />
              <Route
                path="/account"
                element={
                  <Suspense fallback={<LoadingScreen />}>
                    <Account />
                  </Suspense>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
