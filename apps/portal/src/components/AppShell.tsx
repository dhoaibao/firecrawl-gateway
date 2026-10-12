import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { CreditCard, KeyRound, LayoutDashboard, LogOut, UserRound } from "lucide-react";
import { cn } from "@firecrawl-gateway/ui/lib/utils";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/api-keys", label: "API keys", icon: KeyRound, end: false },
  { to: "/cloud-keys", label: "Cloud keys", icon: CreditCard, end: false },
  { to: "/account", label: "Account", icon: UserRound, end: false },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { addToast } = useToast();

  async function signOut() {
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch {
      addToast("Could not sign out. You are still signed in; please try again.");
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-surface-1/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4 lg:px-6">
          <div className="flex shrink-0 items-center gap-2.5">
            <img src="/logo.png" alt="" className="size-7 rounded-md" />
            <span className="hidden text-sm font-semibold sm:inline">Firecrawl Gateway</span>
          </div>
          <nav
            aria-label="Main"
            className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors",
                    isActive
                      ? "bg-white/[0.07] font-medium text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  )
                }
              >
                <item.icon className="size-4" aria-hidden />
                <span className="hidden md:inline">{item.label}</span>
                <span className="sr-only md:hidden">{item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className="hidden max-w-[16rem] truncate text-xs text-muted-foreground lg:inline"
              title={user?.email}
            >
              {user?.email}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut />
              <span className="hidden sm:inline">Sign out</span>
              <span className="sr-only sm:hidden">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <main id="content" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-6 outline-none lg:px-6">
        <Outlet />
      </main>
    </div>
  );
}
