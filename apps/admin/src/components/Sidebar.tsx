import { useEffect, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { LayoutDashboard, Key, LogOut, Menu, Shield, Settings, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReturnFocus } from "@/hooks/useReturnFocus";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

const navItems = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "API Keys", href: "/api-keys", icon: Key },
  { label: "Configure", href: "/configure", icon: Settings },
  { label: "Account", href: "/account", icon: KeyRound },
];

export default function Sidebar() {
  const { admin, logout } = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const returnFocus = useReturnFocus(mobileOpen);

  // The mobile drawer is a modal; close it when the viewport reaches the desktop
  // breakpoint so its overlay, scroll lock and aria-hidden cannot linger.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  const isActive = (href: string) =>
    href === "/" ? location.pathname === "/" : location.pathname === href;

  const sidebarContent = (
    <>
      <div className="flex h-14 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <div className="flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground">
          <Shield className="size-4" />
        </div>
        <span className="text-sm font-semibold text-foreground">Firecrawl Gateway</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Main">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const active = isActive(item.href);
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
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/[0.06] px-3 py-3">
        <div className="mb-2 flex items-center gap-3 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-4 text-xs font-semibold text-foreground">
            {(admin?.email || "A").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">Administrator</div>
            <div className="truncate text-xs text-muted-foreground">{admin?.email}</div>
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
  );

  return (
    <>
      <div className="fixed left-0 right-0 top-0 z-30 flex h-14 items-center justify-between border-b border-white/[0.06] bg-surface-2/90 px-4 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-surface-3 text-muted-foreground">
            <Shield className="size-4" />
          </div>
          <span className="text-sm font-semibold text-foreground">Firecrawl</span>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-8 border-white/[0.08] bg-surface-3 text-foreground"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          aria-expanded={mobileOpen}
        >
          <Menu className="size-4" />
        </Button>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          onCloseAutoFocus={returnFocus}
          className="w-60 max-w-[15rem] gap-0 border-white/[0.06] p-0 lg:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation menu</SheetDescription>
          {sidebarContent}
        </SheetContent>
      </Sheet>

      <aside className="fixed bottom-0 left-0 top-0 z-50 hidden w-60 flex-col border-r border-white/[0.06] bg-surface-1 lg:flex">
        {sidebarContent}
      </aside>
    </>
  );
}
