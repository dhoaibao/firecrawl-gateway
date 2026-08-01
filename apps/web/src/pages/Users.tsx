import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, User, ShieldOff, ShieldCheck, Clock, RefreshCw, Search, Users as UsersIcon, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/hooks/useToast";
import Pagination from "@/components/Pagination";
import PageSkeleton from "@/components/PageSkeleton";
import EmptyState from "@/components/EmptyState";
import DataTable from "@/components/DataTable";
import PageLayout from "@/components/PageLayout";
import { api } from "@/lib/api";
import { formatDate, formatShortDate } from "@/lib/date";
import type { UserData, SuspendUnit } from "@/types";

export default function Users() {
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const { user: currentUser } = useAuth();
  const { confirm: confirmDelete, dialog: confirmDialog } = useConfirmDialog();
  const { confirm: confirmBlock, dialog: blockDialog } = useConfirmDialog();

  const [newUser, setNewUser] = useState({ email: "", name: "", password: "", is_admin: false });
  const [creating, setCreating] = useState(false);

  const [suspendTarget, setSuspendTarget] = useState<UserData | null>(null);
  const [suspendDuration, setSuspendDuration] = useState(1);
  const [suspendUnit, setSuspendUnit] = useState<SuspendUnit>("days");
  const [suspending, setSuspending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended" | "blocked">("all");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");

  // Pagination state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => { document.title = "Users — Firecrawl Gateway" }, []);

  const filteredUsers = users.filter((u) => {
    const matchesSearch =
      !searchQuery ||
      u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || u.status === statusFilter;
    const matchesRole = roleFilter === "all" || (roleFilter === "admin" ? u.is_admin : !u.is_admin);
    return matchesSearch && matchesStatus && matchesRole;
  });

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const paginatedUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);

  const fetchUsers = useCallback(async () => {
    try {
      const json = await api.get<{ data: UserData[] }>("/admin/api/users");
      setUsers(json.data || []);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Error loading users", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    // Load users on mount: standard React pattern for loading authenticated data.
    void fetchUsers();
  }, [fetchUsers]);

  async function handleCreate(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post("/admin/api/users", newUser);
      setNewUser({ email: "", name: "", password: "", is_admin: false });
      setShowForm(false);
      addToast("User created successfully", "success");
      await fetchUsers();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to create user", "error");
    } finally {
      setCreating(false);
    }
  }

  async function doDelete(id: string) {
    try {
      await api.delete(`/admin/api/users/${id}`);
      addToast("User deleted", "success");
      await fetchUsers();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to delete user", "error");
    }
  }

  function handleDelete(id: string) {
    confirmDelete({
      title: "Delete User",
      message: "Are you sure you want to delete this user? This action cannot be undone.",
      confirmLabel: "Delete",
      variant: "danger",
      onConfirm: () => doDelete(id),
    });
  }

  async function handleSuspend(userId: string) {
    setSuspending(true);
    try {
      await api.post(`/admin/api/users/${userId}/suspend`, {
        duration: suspendDuration,
        unit: suspendUnit,
      });
      setSuspendTarget(null);
      addToast("User suspended", "success");
      await fetchUsers();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to suspend user", "error");
    } finally {
      setSuspending(false);
    }
  }

  function openSuspend(user: UserData) {
    setSuspendTarget(user);
    setSuspendDuration(1);
    setSuspendUnit("days");
  }

  function handleBlock(user: UserData) {
    confirmBlock({
      title: "Block User",
      message: `Are you sure you want to permanently block ${user.name}? They will be unable to log in or use API keys until manually activated.`,
      confirmLabel: "Block",
      variant: "danger",
      onConfirm: async () => {
        try {
          await api.post(`/admin/api/users/${user.id}/block`, {});
          addToast("User blocked", "success");
          await fetchUsers();
        } catch (err) {
          addToast(err instanceof Error ? err.message : "Failed to block user", "error");
        }
      },
    });
  }

  async function handleActivate(id: string) {
    setActivatingId(id);
    try {
      await api.post(`/admin/api/users/${id}/activate`, {});
      addToast("User activated", "success");
      await fetchUsers();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to activate user", "error");
    } finally {
      setActivatingId(null);
    }
  }

  function statusBadge(status: string, suspendedUntil: string | null) {
    if (status === "blocked") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-danger-muted px-2 py-0.5 text-xs text-danger-fg">
          <ShieldOff className="size-3" /> Blocked
        </span>
      );
    }
    if (status === "suspended") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-warning-muted px-2 py-0.5 text-xs text-warning-fg">
          <Clock className="size-3" /> Suspended
          {suspendedUntil && (
            <span className="opacity-70">
              until {formatShortDate(suspendedUntil)}
            </span>
          )}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-success-muted px-2 py-0.5 text-xs text-success-fg">
        <ShieldCheck className="size-3" /> Active
      </span>
    );
  }

  if (loading) {
    return <PageSkeleton columns={6} rows={6} />;
  }

  return (
    <PageLayout
      title="Users"
      icon={User}
      count={{ filtered: filteredUsers.length, total: users.length }}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setRefreshing(true); void fetchUsers().then(() => setRefreshing(false)); }}
            disabled={refreshing}
          >
            <RefreshCw className={`size-4 mr-1 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="size-4 mr-1" /> Add user
          </Button>
        </>
      }
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[
          { label: "Active", value: users.filter((u) => u.status === "active").length, tone: "text-success-fg" },
          { label: "Suspended", value: users.filter((u) => u.status === "suspended").length, tone: "text-warning-fg" },
          { label: "Blocked", value: users.filter((u) => u.status === "blocked").length, tone: "text-danger-fg" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-white/[0.06] bg-surface-2 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{item.label}</p>
            <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${item.tone}`}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Search & Filter Bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
            className="pl-9 pr-3"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as "all" | "active" | "suspended" | "blocked"); setPage(1); }}>
          <SelectTrigger className="h-10 bg-surface-3 text-sm px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
            <SelectItem value="blocked">Blocked</SelectItem>
          </SelectContent>
        </Select>
        <Select value={roleFilter} onValueChange={(v) => { setRoleFilter(v as "all" | "admin" | "user"); setPage(1); }}>
          <SelectTrigger className="h-10 bg-surface-3 text-sm px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="user">User</SelectItem>
          </SelectContent>
        </Select>
        {(searchQuery || statusFilter !== "all" || roleFilter !== "all") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setSearchQuery(""); setStatusFilter("all"); setRoleFilter("all"); setPage(1); }}
          >
            Clear
          </Button>
        )}
      </div>

      <Dialog
        open={showForm}
        title="Add user"
        description="Create an account and choose whether it should have administrator access."
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button type="submit" form="create-user-form" size="sm" disabled={creating}>
              {creating ? "Creating..." : "Create user"}
            </Button>
          </>
        }
      >
        <form id="create-user-form" onSubmit={handleCreate} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="new-user-name" className="block text-sm font-medium text-foreground">
              Name
              <Input
                id="new-user-name"
                className="mt-2"
                placeholder="Jane Smith"
                value={newUser.name}
                onChange={(e) => setNewUser((u) => ({ ...u, name: e.target.value }))}
                required
                autoComplete="name"
              />
            </label>
            <label htmlFor="new-user-email" className="block text-sm font-medium text-foreground">
              Email
              <Input
                id="new-user-email"
                className="mt-2"
                type="email"
                placeholder="jane@example.com"
                value={newUser.email}
                onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))}
                required
                autoComplete="email"
              />
            </label>
          </div>
          <label htmlFor="new-user-password" className="block text-sm font-medium text-foreground">
            Temporary password
            <Input
              id="new-user-password"
              className="mt-2"
              type="password"
              placeholder="At least 12 characters"
              value={newUser.password}
              onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))}
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <label className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-2.5 text-sm text-foreground">
            <Checkbox
              checked={newUser.is_admin}
              onChange={(e) => setNewUser((u) => ({ ...u, is_admin: e.target.checked }))}
              aria-label="Grant administrator access"
            />
            <span>
              <span className="block font-medium">Administrator access</span>
              <span className="block text-xs text-muted-foreground">Can manage users and gateway configuration.</span>
            </span>
          </label>
        </form>
      </Dialog>

      <div className="rounded-lg border border-white/[0.06] bg-surface-2 overflow-hidden">
        <DataTable
          columns={[
            { key: "name", header: "Name", render: (u) => u.name },
            { key: "email", header: "Email", className: "text-muted-foreground", render: (u) => u.email },
            {
              key: "role",
              header: "Role",
              render: (u) =>
                u.is_admin ? (
                  <span className="rounded-md bg-warning-muted px-2 py-0.5 text-xs text-warning-fg">Admin</span>
                ) : (
                  <span className="rounded-md bg-surface-4 px-2 py-0.5 text-xs text-muted-foreground">User</span>
                ),
            },
            {
              key: "status",
              header: "Status",
              render: (u) => statusBadge(u.status, u.suspended_until),
            },
            { key: "created", header: "Created", className: "text-muted-foreground", render: (u) => formatDate(u.created_at) },
            {
              key: "actions",
              header: "Actions",
              align: "right",
              render: (u) => (
                <div className="flex items-center justify-end gap-1.5">
                  {u.status === "active" && currentUser?.id !== u.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 border-warning-muted bg-warning-muted/30 text-warning-fg hover:bg-warning-muted/50"
                      onClick={() => openSuspend(u)}
                    >
                      <Clock className="size-3 mr-1" /> Suspend
                    </Button>
                  )}
                  {u.status !== "blocked" && currentUser?.id !== u.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 border-danger-muted bg-danger-muted/30 text-danger-fg hover:bg-danger-muted/50"
                      onClick={() => handleBlock(u)}
                    >
                      <ShieldOff className="size-3 mr-1" /> Block
                    </Button>
                  )}
                  {u.status !== "active" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 border-success-muted bg-success-muted/30 text-success-fg hover:bg-success-muted/50"
                      onClick={() => handleActivate(u.id)}
                      disabled={activatingId === u.id}
                    >
                      {activatingId === u.id ? <Loader2 className="size-3 mr-1 animate-spin" /> : <ShieldCheck className="size-3 mr-1" />} Activate
                    </Button>
                  )}
                  {currentUser?.id !== u.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 border-white/[0.08] bg-surface-3 text-muted-foreground hover:bg-surface-4"
                      onClick={() => handleDelete(u.id)}
                    >
                      <Trash2 className="size-3 mr-1" /> Delete
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
          data={paginatedUsers}
          keyExtractor={(u) => u.id}
          emptyState={
            <EmptyState
              icon={UsersIcon}
              title={users.length === 0 ? "No users found" : "No users match your filters"}
              description={users.length === 0 ? "Get started by adding your first user." : "Try adjusting your search or filter criteria."}
              action={users.length === 0 ? { label: "Add user", onClick: () => setShowForm(true) } : undefined}
            />
          }
        />
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={filteredUsers.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* Suspend Dialog */}
      {suspendTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setSuspendTarget(null); }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="suspend-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-white/[0.08] bg-surface-2 p-5 shadow-xl space-y-4">
            <h3 id="suspend-title" className="text-base font-semibold">Suspend User</h3>
            <p className="text-sm text-muted-foreground">
              Suspend <span className="font-medium text-foreground">{suspendTarget.name}</span> for a period of time. They will be unable to log in or use API keys until the suspension expires.
            </p>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Duration</label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={suspendDuration}
                    onChange={(e) => setSuspendDuration(Math.max(1, parseInt(e.target.value) || 1))}
                    className="h-9 w-20"
                  />
                  <Select value={suspendUnit} onValueChange={(v) => setSuspendUnit(v as SuspendUnit)}>
                    <SelectTrigger className="h-9 flex-1 bg-surface-3 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hours">Hour(s)</SelectItem>
                      <SelectItem value="days">Day(s)</SelectItem>
                      <SelectItem value="weeks">Week(s)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setSuspendTarget(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-warning-fg text-background hover:bg-warning-fg/90"
                onClick={() => handleSuspend(suspendTarget.id)}
                disabled={suspending}
              >
                {suspending ? "Suspending..." : "Suspend"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog}
      {blockDialog}
    </PageLayout>
  );
}
