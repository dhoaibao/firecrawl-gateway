import { Suspense, lazy } from "react"
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom"
import { useAuth } from "@/contexts/AuthContext"
import { ToastProvider } from "@/contexts/ToastContext"
import ErrorBoundary from "@/components/ErrorBoundary"
import Sidebar from "@/components/Sidebar"

const Dashboard = lazy(() => import("@/pages/Dashboard"))
const Login = lazy(() => import("@/pages/Login"))
const Users = lazy(() => import("@/pages/Users"))
const ApiKeys = lazy(() => import("@/pages/ApiKeys"))
const Configure = lazy(() => import("@/pages/Configure"))
const Account = lazy(() => import("@/pages/Account"))

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
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return <LoadingScreen />
  }
  if (!user) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return <LoadingScreen />
  }
  if (!user?.is_admin) {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}

function AuthenticatedLayout() {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 pt-14 lg:pt-0">
        <Outlet />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter basename="/admin">
          <a href="#content" className="skip-link">
            Skip to content
          </a>
          <Routes>
            <Route path="/login" element={
              <Suspense fallback={<LoadingScreen />}>
                <Login />
              </Suspense>
            } />
            <Route
              element={
                <RequireAuth>
                  <AuthenticatedLayout />
                </RequireAuth>
              }
            >
              <Route path="/" element={
                <Suspense fallback={<LoadingScreen />}>
                  <Dashboard />
                </Suspense>
              } />
              <Route
                path="/users"
                element={
                  <RequireAdmin>
                    <Suspense fallback={<LoadingScreen />}>
                      <Users />
                    </Suspense>
                  </RequireAdmin>
                }
              />
              <Route path="/api-keys" element={
                <Suspense fallback={<LoadingScreen />}>
                  <ApiKeys />
                </Suspense>
              } />
              <Route
                path="/configure"
                element={
                  <RequireAdmin>
                    <Suspense fallback={<LoadingScreen />}>
                      <Configure />
                    </Suspense>
                  </RequireAdmin>
                }
              />
              <Route path="/account" element={
                <Suspense fallback={<LoadingScreen />}>
                  <Account />
                </Suspense>
              } />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  )
}
