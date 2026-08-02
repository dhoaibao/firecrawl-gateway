import { useEffect, type ComponentType } from "react"
import { Navigate, Outlet, RouterProvider, createBrowserRouter, type RouteObject, useLocation, useNavigate } from "react-router-dom"
import { useAuth } from "@/contexts/AuthContext"
import { ToastProvider } from "@/contexts/ToastContext"
import ErrorBoundary from "@/components/ErrorBoundary"
import Sidebar from "@/components/Sidebar"

function LoadingScreen() {
  return <div className="flex min-h-screen items-center justify-center bg-background animate-fade-in"><div className="flex flex-col items-center gap-4"><div className="size-10 animate-pulse rounded-xl border border-white/[0.08] bg-surface-2"><div className="size-full rounded-xl bg-gradient-to-br from-white/[0.06] to-transparent" /></div><div className="h-2 w-24 animate-pulse rounded-full bg-white/[0.06]" /></div></div>
}

function RouteErrorBoundary() {
  return <div className="flex min-h-screen items-center justify-center bg-background px-4"><div className="max-w-md rounded-xl border border-danger-muted bg-surface-2 p-6 text-center"><h1 className="text-lg font-semibold">This page is unavailable</h1><p className="mt-2 text-sm text-muted-foreground">The page could not be loaded safely. Return to your workspace and try again.</p><a href="/app" className="mt-4 inline-flex text-sm text-info-fg hover:underline">Return to workspace</a></div></div>
}

function AccessRedirects() {
  const navigate = useNavigate()
  useEffect(() => {
    const verification = () => navigate("/verify-email")
    const mfa = () => navigate("/app/security")
    window.addEventListener("gateway:verification-required", verification)
    window.addEventListener("gateway:mfa-required", mfa)
    return () => {
      window.removeEventListener("gateway:verification-required", verification)
      window.removeEventListener("gateway:mfa-required", mfa)
    }
  }, [navigate])
  return null
}

function RootLayout() {
  return <><AccessRedirects /><a href="#content" className="skip-link">Skip to content</a><Outlet /></>
}

function HomeRedirect() {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  return <Navigate to={user ? "/app" : "/login"} replace />
}

function UserLayout() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
  if (user.email_verified_at === null) return <Navigate to="/verify-email" replace />
  return <div className="flex min-h-screen bg-background"><Sidebar mode="user" /><main className="flex-1 pt-14 lg:pt-0"><Outlet /></main></div>
}

function AdminLayout() {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login?next=%2Fadmin" replace />
  if (!user.is_admin) return <Navigate to="/app" replace />
  return <div className="flex min-h-screen bg-background"><Sidebar mode="admin" /><main className="flex-1 pt-14 lg:pt-0"><Outlet /></main></div>
}

function lazyPage(loader: () => Promise<{ default: ComponentType }>) {
  return async () => ({ Component: (await loader()).default })
}

const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: "login", lazy: lazyPage(() => import("@/pages/Login")) },
      { path: "register", lazy: lazyPage(() => import("@/pages/Register")) },
      { path: "verify-email", lazy: lazyPage(() => import("@/pages/VerifyEmail")) },
      { path: "forgot-password", lazy: lazyPage(() => import("@/pages/ForgotPassword")) },
      { path: "reset-password", lazy: lazyPage(() => import("@/pages/ResetPassword")) },
      {
        path: "app",
        element: <UserLayout />,
        errorElement: <RouteErrorBoundary />,
        children: [
          { index: true, lazy: lazyPage(() => import("@/features/portal/Dashboard")) },
          { path: "endpoint", lazy: lazyPage(() => import("@/features/portal/Endpoint")) },
          { path: "tokens", lazy: lazyPage(() => import("@/features/portal/Tokens")) },
          { path: "credentials", lazy: lazyPage(() => import("@/features/portal/Credentials")) },
          { path: "usage", lazy: lazyPage(() => import("@/features/portal/Usage")) },
          { path: "request-history", lazy: lazyPage(() => import("@/features/portal/RequestHistory")) },
          { path: "playground", lazy: lazyPage(() => import("@/features/portal/Playground")) },
          { path: "security", lazy: lazyPage(() => import("@/features/portal/Security")) },
          { path: "account", lazy: lazyPage(() => import("@/features/portal/Account")) },
          { path: "*", element: <Navigate to="/app" replace /> },
        ],
      },
      { path: "admin/login", element: <Navigate to="/login?next=%2Fadmin" replace /> },
      { path: "admin/verify-email", element: <Navigate to="/verify-email" replace /> },
      { path: "admin/reset-password", element: <Navigate to="/reset-password" replace /> },
      {
        path: "admin",
        element: <AdminLayout />,
        errorElement: <RouteErrorBoundary />,
        children: [
          { index: true, lazy: lazyPage(() => import("@/pages/Dashboard")) },
          { path: "users", lazy: lazyPage(() => import("@/pages/Users")) },
          { path: "api-keys", lazy: lazyPage(() => import("@/pages/ApiKeys")) },
          { path: "configure", lazy: lazyPage(() => import("@/pages/Configure")) },
          { path: "account", lazy: lazyPage(() => import("@/pages/Account")) },
          { path: "*", element: <Navigate to="/admin" replace /> },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]

const router = createBrowserRouter(routes)

export default function App() {
  return <ErrorBoundary><ToastProvider><RouterProvider router={router} /></ToastProvider></ErrorBoundary>
}
