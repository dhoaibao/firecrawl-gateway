import { useEffect, useState, type ComponentType } from "react"
import { useLocation, Link } from "react-router"
import {
  Activity,
  Bell,
  BookOpen,
  Clock3,
  Cloud,
  Database,
  Gauge,
  Key,
  LayoutDashboard,
  LogOut,
  Menu,
  Play,
  Settings,
  Shield,
  UserRound,
  Users,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/contexts/AuthContext"
import { Button } from "@/components/ui/button"

interface NavItem {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  adminOnly?: boolean
}

const userNavItems: NavItem[] = [
  { label: "Dashboard", href: "/app", icon: LayoutDashboard },
  { label: "Endpoint", href: "/app/endpoint", icon: Activity },
  { label: "Tokens", href: "/app/tokens", icon: Key },
  { label: "BYOK Credentials", href: "/app/credentials", icon: Cloud },
  { label: "Usage", href: "/app/usage", icon: Gauge },
  { label: "Request History", href: "/app/request-history", icon: Clock3 },
  { label: "Playground", href: "/app/playground", icon: Play },
  { label: "Security", href: "/app/security", icon: Shield },
  { label: "Account", href: "/app/account", icon: UserRound },
]

const adminNavItems: NavItem[] = [
  { label: "Overview", href: "/admin", icon: LayoutDashboard },
  { label: "Capacity", href: "/admin/capacity", icon: Gauge },
  { label: "Accounts", href: "/admin/accounts", icon: Users },
  { label: "Waitlist", href: "/admin/waitlist", icon: Users },
  { label: "Infrastructure", href: "/admin/infrastructure", icon: Database },
  { label: "Usage", href: "/admin/usage", icon: Gauge },
  { label: "Requests", href: "/admin/requests", icon: Activity },
  { label: "Notifications", href: "/admin/notifications", icon: Bell },
  { label: "Security", href: "/admin/security", icon: Shield },
  { label: "Configuration", href: "/admin/configuration", icon: Settings },
]

interface SidebarProps {
  mode?: "user" | "admin"
}

export default function Sidebar({ mode = "admin" }: SidebarProps) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const navItems = mode === "user" ? userNavItems : adminNavItems
  const root = mode === "user" ? "/app" : "/admin"

  useEffect(() => {
    if (!mobileOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false)
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [mobileOpen])

  const isActive = (href: string) => {
    if (href === root) return location.pathname === href || location.pathname === `${href}/`
    return location.pathname === href || location.pathname.startsWith(`${href}/`)
  }

  const sidebarContent = (
    <>
      <div className="flex h-14 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <div className="flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground">
          <Shield className="size-4" />
        </div>
        <span className="text-sm font-semibold text-foreground">
          {mode === "user" ? "Firecrawl Gateway" : "Gateway Operations"}
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label={mode === "user" ? "Workspace" : "Operator navigation"}>
        <ul className="space-y-1">
          {navItems
            .filter((item) => !item.adminOnly || user?.is_admin)
            .map((item) => {
              const active = isActive(item.href)
              return (
                <li key={item.href}>
                  <Link
                    to={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-white/[0.06] font-medium text-foreground before:absolute before:left-0 before:top-1.5 before:h-5 before:w-[3px] before:rounded-r-full before:bg-foreground"
                        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                  </Link>
                </li>
              )
            })}
        </ul>
        {mode === "user" && (
          <p className="mt-5 px-3 text-[10px] leading-relaxed text-muted-foreground/70">
            <BookOpen className="mr-1 inline size-3" /> Your endpoint and integration secrets stay scoped to this workspace.
          </p>
        )}
      </nav>

      <div className="border-t border-white/[0.06] px-3 py-3">
        <div className="mb-2 flex items-center gap-3 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-4 text-xs font-semibold text-foreground">
            {(user?.name || user?.email || "U").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{user?.name || "User"}</div>
            <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
          </div>
        </div>
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2.5 px-3 text-sm font-normal text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
          onClick={() => void logout()}
        >
          <LogOut className="size-4" />
          Logout
        </Button>
      </div>
    </>
  )

  return (
    <>
      <div className="fixed left-0 right-0 top-0 z-30 flex h-14 items-center justify-between border-b border-white/[0.06] bg-surface-2/90 px-4 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground"><Shield className="size-4" /></div>
          <span className="text-sm font-semibold text-foreground">Firecrawl</span>
        </div>
        <Button variant="outline" size="icon" className="size-8 border-white/[0.08] bg-surface-3 text-foreground" onClick={() => setMobileOpen((value) => !value)} aria-label={mobileOpen ? "Close menu" : "Open menu"} aria-expanded={mobileOpen}>
          {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </Button>
      </div>

      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />}

      <aside className={cn("fixed bottom-0 left-0 top-0 z-50 flex w-60 flex-col border-r border-white/[0.06] bg-surface-1 transition-transform duration-200 lg:translate-x-0", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
        {sidebarContent}
      </aside>
      <div className="hidden lg:block lg:w-60" />
    </>
  )
}
