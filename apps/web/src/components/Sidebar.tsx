import { useEffect, useState } from "react"
import { useLocation, Link } from "react-router-dom"
import {
  LayoutDashboard,
  Key,
  Users,
  LogOut,
  Menu,
  X,
  Shield,
  Settings,
  KeyRound,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/contexts/AuthContext"
import { Button } from "@/components/ui/button"

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  adminOnly?: boolean
}

const navItems: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "API Keys", href: "/api-keys", icon: Key },
  { label: "Users", href: "/users", icon: Users, adminOnly: true },
  { label: "Configure", href: "/configure", icon: Settings, adminOnly: true },
  { label: "Account", href: "/account", icon: KeyRound },
]

export default function Sidebar() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    if (!mobileOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false)
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [mobileOpen])

  const isActive = (href: string) => {
    if (href === "/") {
      return location.pathname === "/"
    }
    return location.pathname === href
  }

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <div className="flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground">
          <Shield className="size-4" />
        </div>
        <span className="text-sm font-semibold text-foreground">
          Firecrawl Gateway
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Main">
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
      </nav>

      {/* User + Logout */}
      <div className="border-t border-white/[0.06] px-3 py-3">
        <div className="mb-2 flex items-center gap-3 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-4 text-xs font-semibold text-foreground">
            {(user?.name || user?.email || "U").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {user?.name || "User"}
            </div>
            <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
          </div>
        </div>
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2.5 px-3 text-sm font-normal text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
          onClick={() => logout()}
        >
          <LogOut className="size-4" />
          Logout
        </Button>
      </div>
    </>
  )

  return (
    <>
      {/* Mobile top bar */}
      <div className="fixed left-0 right-0 top-0 z-30 flex h-14 items-center justify-between border-b border-white/[0.06] bg-surface-2/90 px-4 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground">
            <Shield className="size-4" />
          </div>
          <span className="text-sm font-semibold text-foreground">
            Firecrawl
          </span>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-8 border-white/[0.08] bg-surface-3 text-foreground"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </Button>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — mobile drawer / desktop fixed */}
      <aside
        className={cn(
          "fixed bottom-0 left-0 top-0 z-50 flex w-60 flex-col border-r border-white/[0.06] bg-surface-1 transition-transform duration-200 lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {sidebarContent}
      </aside>

      {/* Spacer for desktop sidebar */}
      <div className="hidden lg:block lg:w-60" />
    </>
  )
}
