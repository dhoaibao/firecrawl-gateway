import { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Search,
  ShieldOff,
  ShieldCheck,
  Trash2,
  Users as UsersIcon,
} from "lucide-react";
import { Badge } from "@firecrawl-gateway/ui/components/badge";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { Input } from "@firecrawl-gateway/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@firecrawl-gateway/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@firecrawl-gateway/ui/components/sheet";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import DataTable, { type Column } from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageLayout from "@/components/PageLayout";
import PageSkeleton from "@/components/PageSkeleton";
import Pagination from "@/components/Pagination";
import { useReturnFocus } from "@/hooks/useReturnFocus";
import { useToast } from "@/hooks/useToast";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/date";
import type { UserDetail, UserLimits, UserState, UserSummary } from "@/types";

type StateFilter = UserState | "all";

interface Defaults {
  max_api_keys: number;
  rate_limit_per_minute: number;
  monthly_quota: number | null;
}

const STATE_BADGE: Record<UserState, "success" | "warning" | "secondary"> = {
  active: "success",
  suspended: "warning",
  deleted: "secondary",
};

/** A whole number between 1 and `max`, null for an empty input, or a user-facing error string. */
function parseOverride(input: string, label: string, max: number): number | null | string {
  if (!input.trim()) return null;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > max)
    return `${label} must be a whole number between 1 and ${max}.`;
  return value;
}

export default function Users() {
  const { addToast } = useToast();
  const { confirm, dialog } = useConfirmDialog();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<StateFilter>("active");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [maxKeys, setMaxKeys] = useState("");
  const [rate, setRate] = useState("");
  const [quota, setQuota] = useState("");
  const [saving, setSaving] = useState(false);
  const returnFocus = useReturnFocus(selectedId !== null);
  // Counts drawer opens and closes. A GET or PATCH remembers the value it started under and
  // may update the drawer only if it is still current: a slow response that finished after
  // the drawer was closed, switched to another user, or reopened for the same one would
  // otherwise overwrite newer data and leave the limits form pointing at stale values.
  const drawerGenerationRef = useRef(0);

  useEffect(() => {
    document.title = "Users — Firecrawl Gateway";
  }, []);

  // Debounce typing so each keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Every list request takes a sequence number; only the newest may write the list, so
  // an out-of-order or late response (including one started before a filter change) can
  // never replace results that belong to the filters on screen.
  const listSequenceRef = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++listSequenceRef.current;
    const params = new URLSearchParams({
      state,
      limit: String(pageSize),
      offset: String((page - 1) * pageSize),
    });
    if (query) params.set("search", query);
    try {
      const json = await api.get<{ data: UserSummary[]; total: number; defaults: Defaults }>(
        `/admin/api/users?${params.toString()}`,
      );
      if (sequence !== listSequenceRef.current) return;
      setUsers(json.data);
      setTotal(json.total);
      setDefaults(json.defaults);
      setError("");
    } catch (err) {
      if (sequence !== listSequenceRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      if (sequence === listSequenceRef.current) setLoading(false);
    }
  }, [state, page, pageSize, query]);

  // A mutation that finishes later must refresh with the filters on screen then, not the
  // ones its render captured, so completions go through this ref.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const showDetail = useCallback(
    async (id: string) => {
      const generation = ++drawerGenerationRef.current;
      setSelectedId(id);
      setDetail(null);
      setDetailLoading(true);
      try {
        const json = await api.get<{ data: UserDetail }>(
          `/admin/api/users/${encodeURIComponent(id)}`,
        );
        if (drawerGenerationRef.current !== generation) return;
        setDetail(json.data);
        setMaxKeys(json.data.limits.max_api_keys?.toString() ?? "");
        setRate(json.data.limits.rate_limit_per_minute?.toString() ?? "");
        setQuota(json.data.limits.monthly_quota?.toString() ?? "");
      } catch (err) {
        if (drawerGenerationRef.current !== generation) return;
        addToast(err instanceof Error ? err.message : "Failed to load user", "error");
        drawerGenerationRef.current += 1;
        setSelectedId(null);
      } finally {
        if (drawerGenerationRef.current === generation) setDetailLoading(false);
      }
    },
    [addToast],
  );

  function closeDetail() {
    drawerGenerationRef.current += 1;
    setSelectedId(null);
    setDetail(null);
  }

  async function applyPatch(id: string, body: Record<string, unknown>, success: string) {
    const generation = drawerGenerationRef.current;
    setSaving(true);
    try {
      const json = await api.patch<{ data: UserDetail }>(
        `/admin/api/users/${encodeURIComponent(id)}`,
        body,
      );
      // Only show the result if this same drawer is still the open one.
      if (drawerGenerationRef.current === generation) setDetail(json.data);
      addToast(success, "success");
      void loadRef.current();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to update user", "error");
    } finally {
      setSaving(false);
    }
  }

  function saveLimits(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const max_api_keys = parseOverride(maxKeys, "Key cap", 1000);
    const rate_limit_per_minute = parseOverride(rate, "Rate limit", 100_000);
    const monthly_quota = parseOverride(quota, "Monthly quota", 100_000_000);
    for (const value of [max_api_keys, rate_limit_per_minute, monthly_quota]) {
      if (typeof value === "string") {
        addToast(value, "error");
        return;
      }
    }
    void applyPatch(
      detail.id,
      { max_api_keys, rate_limit_per_minute, monthly_quota },
      "Limits saved",
    );
  }

  function toggleSuspended(user: UserDetail) {
    const suspend = user.state === "active";
    confirm({
      title: suspend ? "Suspend user" : "Reactivate user",
      message: suspend
        ? `${user.email} is signed out everywhere and their API keys stop working. Their data is kept.`
        : `${user.email} can sign in again and their keys work again.`,
      confirmLabel: suspend ? "Suspend" : "Reactivate",
      variant: suspend ? "warning" : "danger",
      onConfirm: () =>
        void applyPatch(
          user.id,
          { status: suspend ? "suspended" : "active" },
          suspend ? "User suspended" : "User reactivated",
        ),
    });
  }

  function deleteUser(user: UserDetail) {
    confirm({
      title: "Delete user",
      message: `${user.email} is signed out, their API keys are revoked and their stored Cloud keys are erased. This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
      onConfirm: () =>
        void (async () => {
          const generation = drawerGenerationRef.current;
          try {
            await api.delete(`/admin/api/users/${encodeURIComponent(user.id)}`);
            addToast("User deleted", "success");
            // Close only the drawer this deletion was started from, not one opened since.
            if (drawerGenerationRef.current === generation) closeDetail();
            void loadRef.current();
          } catch (err) {
            addToast(err instanceof Error ? err.message : "Failed to delete user", "error");
          }
        })(),
    });
  }

  const columns: Column<UserSummary>[] = [
    {
      key: "user",
      header: "User",
      render: (user) => (
        <button
          type="button"
          onClick={() => void showDetail(user.id)}
          className="flex min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-md"
        >
          {user.avatar_url ? (
            <img
              src={user.avatar_url}
              alt=""
              referrerPolicy="no-referrer"
              className="size-8 shrink-0 rounded-full border border-white/[0.08]"
            />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-4 text-xs font-semibold">
              {user.email.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">
              {user.name || user.email}
            </span>
            {user.name && (
              <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
            )}
          </span>
        </button>
      ),
    },
    {
      key: "state",
      header: "Status",
      render: (user) => <Badge variant={STATE_BADGE[user.state]}>{user.state}</Badge>,
    },
    {
      key: "keys",
      header: "API / Cloud keys",
      align: "right",
      className: "font-mono tabular-nums",
      render: (user) => `${user.api_keys} / ${user.cloud_keys}`,
    },
    {
      key: "signin",
      header: "Sign-in",
      className: "hidden md:table-cell text-muted-foreground",
      render: (user) => user.providers.join(", ") || "—",
    },
    {
      key: "last",
      header: "Last sign-in",
      className: "hidden lg:table-cell text-muted-foreground",
      render: (user) => formatDate(user.last_login_at),
    },
    {
      key: "joined",
      header: "Joined",
      className: "hidden xl:table-cell text-muted-foreground",
      render: (user) => formatDate(user.created_at),
    },
  ];

  if (loading) return <PageSkeleton columns={5} rows={6} />;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = query !== "" || state !== "active";

  return (
    <PageLayout
      title="Users"
      icon={UsersIcon}
      count={{ filtered: users.length, total }}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void load().then(() => setRefreshing(false));
          }}
        >
          <RefreshCw className={`size-4 mr-1 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
      }
    >
      <p className="mb-4 max-w-3xl text-xs text-muted-foreground">
        Customers who signed in to the portal. Each uses their own Firecrawl Cloud keys; suspending
        a user signs them out and stops their gateway keys. The administrator account is not listed
        here.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by email or name..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9 pr-3"
            aria-label="Search users"
          />
        </div>
        <Select
          value={state}
          onValueChange={(value) => {
            setState(value as StateFilter);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-10 bg-surface-3 px-3 text-sm" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
            <SelectItem value="deleted">Deleted</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        {filtered && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSearch("");
              setQuery("");
              setState("active");
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger-muted bg-danger-muted/40 px-4 py-3 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-surface-2">
        <DataTable
          columns={columns}
          data={users}
          keyExtractor={(user) => user.id}
          emptyState={
            <EmptyState
              icon={UsersIcon}
              title={filtered ? "No users match" : "No users yet"}
              description={
                filtered
                  ? "Try a different search or status."
                  : "Users appear here after they sign in to the customer portal."
              }
            />
          }
        />
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </div>

      <Sheet open={selectedId !== null} onOpenChange={(open) => !open && closeDetail()}>
        <SheetContent
          className="w-full gap-0 overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={returnFocus}
        >
          <SheetHeader className="border-b border-white/[0.06] pr-12">
            <SheetTitle className="truncate">{detail?.name || detail?.email || "User"}</SheetTitle>
            <SheetDescription className="truncate">{detail?.email ?? "Loading…"}</SheetDescription>
          </SheetHeader>

          {detailLoading || !detail ? (
            <p className="p-4 text-sm text-muted-foreground" aria-busy="true">
              Loading…
            </p>
          ) : (
            <div className="space-y-6 p-4">
              <section aria-label="Status" className="flex flex-wrap items-center gap-3">
                <Badge variant={STATE_BADGE[detail.state]}>{detail.state}</Badge>
                <span className="text-xs text-muted-foreground">
                  {detail.active_sessions} active session{detail.active_sessions === 1 ? "" : "s"}
                  {" · "}last sign-in {formatDate(detail.last_login_at)}
                </span>
                {detail.state !== "deleted" && (
                  <div className="ml-auto flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => toggleSuspended(detail)}
                    >
                      {detail.state === "active" ? (
                        <>
                          <ShieldOff className="size-4 mr-1" /> Suspend
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="size-4 mr-1" /> Reactivate
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-danger-muted text-danger-fg"
                      disabled={saving}
                      onClick={() => deleteUser(detail)}
                    >
                      <Trash2 className="size-4 mr-1" /> Delete
                    </Button>
                  </div>
                )}
              </section>

              {detail.state !== "deleted" && defaults && (
                <section aria-labelledby="limits-heading">
                  <h3 id="limits-heading" className="mb-2 text-sm font-semibold">
                    Limits
                  </h3>
                  <form onSubmit={saveLimits} className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <LimitField
                        id="limit-keys"
                        label="API key cap"
                        value={maxKeys}
                        onChange={setMaxKeys}
                        placeholder={`${defaults.max_api_keys} (default)`}
                        max={1000}
                      />
                      <LimitField
                        id="limit-rate"
                        label="Requests / min"
                        value={rate}
                        onChange={setRate}
                        placeholder={`${defaults.rate_limit_per_minute} (default)`}
                        max={100000}
                      />
                      <LimitField
                        id="limit-quota"
                        label="Monthly quota"
                        value={quota}
                        onChange={setQuota}
                        placeholder="No quota (default)"
                        max={100000000}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Empty uses the default. Rate limit and quota apply to the user&apos;s keys
                      right away; lowering the key cap only stops new keys.
                    </p>
                    <Button type="submit" size="sm" disabled={saving}>
                      {saving ? "Saving..." : "Save limits"}
                    </Button>
                  </form>
                </section>
              )}

              <DetailList
                title="Sign-in methods"
                empty="None"
                rows={detail.identities.map((identity) => ({
                  key: identity.provider,
                  primary: identity.provider,
                  secondary: `${identity.email} · linked ${formatDate(identity.linked_at)}`,
                }))}
              />
              <DetailList
                title="Gateway API keys"
                empty="No keys"
                rows={detail.api_key_list.map((key) => ({
                  key: key.id,
                  primary: `${key.name} · ${key.key_prefix}…`,
                  secondary: key.revoked
                    ? `Revoked · created ${formatDate(key.created_at)}`
                    : `Last used ${formatDate(key.last_used_at)}${
                        key.rate_limit_per_minute ? ` · ${key.rate_limit_per_minute}/min` : ""
                      }`,
                  muted: key.revoked,
                }))}
              />
              <DetailList
                title="Cloud keys"
                empty="None stored"
                rows={detail.cloud_key_list.map((key) => ({
                  key: key.id,
                  primary: `${key.name} · ${key.key_prefix}…`,
                  secondary: `${key.role} · checked ${formatDate(key.last_verified_at)}`,
                }))}
              />
              <EffectiveLimits limits={detail.effective_limits} />
            </div>
          )}
        </SheetContent>
      </Sheet>

      {dialog}
    </PageLayout>
  );
}

function LimitField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  max: number;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={props.id} className="block text-xs font-medium text-foreground">
        {props.label}
      </label>
      <Input
        id={props.id}
        type="number"
        inputMode="numeric"
        min={1}
        max={props.max}
        step={1}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function DetailList(props: {
  title: string;
  empty: string;
  rows: Array<{ key: string; primary: string; secondary: string; muted?: boolean }>;
}) {
  return (
    <section aria-label={props.title}>
      <h3 className="mb-2 text-sm font-semibold">{props.title}</h3>
      {props.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="divide-y divide-white/[0.05] rounded-lg border border-white/[0.06] bg-surface-1">
          {props.rows.map((row) => (
            <li key={row.key} className={`px-3 py-2 ${row.muted ? "opacity-60" : ""}`}>
              <p className="truncate text-sm">{row.primary}</p>
              <p className="truncate text-xs text-muted-foreground">{row.secondary}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EffectiveLimits({ limits }: { limits: UserLimits }) {
  return (
    <p className="text-xs text-muted-foreground">
      Effective: up to {limits.max_api_keys} keys, {limits.rate_limit_per_minute} requests/min
      {limits.monthly_quota ? `, ${limits.monthly_quota} requests/month` : ", no monthly quota"}.
    </p>
  );
}
