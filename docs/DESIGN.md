---
name: Firecrawl Gateway Admin UI
colors:
  background: hsl(230 14% 6%)
  foreground: hsl(210 30% 96%)
  surface-1: hsl(230 12% 8%)
  surface-2: hsl(230 11% 10%)
  surface-3: hsl(230 10% 13%)
  surface-4: hsl(230 9% 16%)
  primary: hsl(210 30% 96%)
  primary-foreground: hsl(230 14% 6%)
  secondary: hsl(230 9% 16%)
  muted: hsl(230 9% 16%)
  muted-foreground: hsl(215 14% 58%)
  accent: hsl(230 9% 18%)
  destructive: hsl(354 78% 62%)
  success: hsl(155 58% 45%)
  warning: hsl(38 85% 55%)
  info: hsl(210 75% 58%)
  border: hsl(230 8% 18%)
  ring: hsl(215 20% 55%)
typography:
  family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
  mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace
spacing:
  section: 1rem
  inline: 0.5rem
  card-x: 1.25rem
  card-y: 1.25rem
  table-cell-x: 1rem
  table-cell-y: 0.75rem
rounded:
  sm: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  2xl: 1rem
---

# Frontend Design Standard — Firecrawl Gateway Admin UI

## Product Character

A dark-themed, data-dense administrative dashboard for operating a hybrid Firecrawl API gateway. The UI emphasizes clarity for high-volume audit logs, quick status scanning, and low-friction configuration. The aesthetic is technical and elevated: deep slate surfaces, subtle borders, muted semantic color accents, and restrained motion.

## Audience And Workflows

- **Operators and admins** monitor live gateway traffic, success rates, fallback behavior, and latency.
- **Admins** manage users (create, suspend, block, activate, delete) and API keys (create, revoke).
- **Admins** configure routing policy, inactivity policies, and Firecrawl Cloud API key priority.
- All authenticated pages share a persistent sidebar; the dashboard auto-refreshes every 5 seconds when "Live" is enabled.

## Visual Principles

- **Dark-first, always.** `color-scheme: dark` is enforced; components should not introduce light-mode surfaces.
- **Subtle elevation through borders.** Surfaces are separated by low-opacity white borders (`border-white/[0.06]` to `border-white/[0.08]`) rather than heavy shadows.
- **Muted semantic accents.** Status uses `success`, `warning`, `info`, and `danger` with dedicated muted background and foreground pairs.
- **Compact density.** Tables, metric cards, and filter bars use small text sizes (`text-[11px]` to `text-sm`) and tight padding to fit large datasets.
- **Restrained motion.** Transitions are short (150–300 ms); animations are subtle fades, slides, and pulses. Respect `prefers-reduced-motion`.

## Layout System

- **App shell:** fixed 240 px left sidebar (`w-60`) on desktop; mobile uses a top bar and drawer overlay.
- **Router basename:** Admin UI is served under `/admin` (`BrowserRouter basename="/admin"`).
- **Content max-width:** `max-w-[1680px]` centered with `mx-auto`.
- **Content padding:** `px-4 py-4 lg:px-6`.
- **Main content offset:** `pt-14 lg:pt-0` to clear the mobile top bar.
- **Page header pattern:** icon (`size-5`) + title + optional count + right-aligned actions, separated by `mb-6`.
- **Grid conventions:**
  - Metric grid: `grid gap-3 sm:grid-cols-2 xl:grid-cols-5`.
  - Charts: `grid grid-cols-1 gap-4 lg:grid-cols-2`.
  - Filter bar: `grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4`.
- **Sticky elements:** Dashboard toolbar is sticky top with `bg-surface-2/90 backdrop-blur`.

## Color System

Source of truth is `apps/web/src/index.css` using Tailwind CSS v4 `@theme`.

### Base surfaces

| Role | Variable | Value | Usage |
|------|----------|-------|-------|
| Background | `--color-background` | `hsl(230 14% 6%)` | Page background |
| Foreground | `--color-foreground` | `hsl(210 30% 96%)` | Primary text |
| Surface 1 | `--color-surface-1` | `hsl(230 12% 8%)` | Sidebar |
| Surface 2 | `--color-surface-2` | `hsl(230 11% 10%)` | Cards, input backgrounds |
| Surface 3 | `--color-surface-3` | `hsl(230 10% 13%)` | Card headers, table headers |
| Surface 4 | `--color-surface-4` | `hsl(230 9% 16%)` | Elevated headers, hover states |

### shadcn-compatible tokens

`card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring` are defined and should be used through Tailwind utilities (e.g., `bg-card`, `text-muted-foreground`, `border-input`).

### Semantic palette

| Role | Default | Muted background | Foreground |
|------|---------|------------------|------------|
| Success | `--color-success` | `--color-success-muted` | `--color-success-fg` |
| Warning | `--color-warning` | `--color-warning-muted` | `--color-warning-fg` |
| Info | `--color-info` | `--color-info-muted` | `--color-info-fg` |
| Danger | `--color-danger` | `--color-danger-muted` | `--color-danger-fg` |

Use muted/foreground pairs for badges, pills, alerts, toasts, and status indicators.

### Border and focus

- Default border: `border-white/[0.06]`.
- Input border: `border-white/[0.08]`; hover to `border-white/12`.
- Button focus ring: `focus-visible:ring-ring/50 focus-visible:ring-[3px]`.
- Input/select focus ring: `focus:border-ring focus:ring-2 focus:ring-ring/30`.
- Active/selected accent: `bg-white/[0.06]`.

## Shadow Tokens

Defined in `index.css` and referenced via `shadow-[var(--shadow-*)]`:

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-card` | `0 1px 3px 0 rgb(0 0 0 / 0.3), 0 1px 2px -1px rgb(0 0 0 / 0.2)` | Default card elevation |
| `--shadow-card-hover` | `0 10px 15px -3px rgb(0 0 0 / 0.4), 0 4px 6px -4px rgb(0 0 0 / 0.3)` | Card hover lift |
| `--shadow-modal` | `0 25px 50px -12px rgb(0 0 0 / 0.5)` | Dialogs, login panel |
| `--shadow-glow` | `0 0 20px -5px hsl(215 90% 56% / 0.15)` | Subtle glow accents (rare) |

## Animation Tokens

| Token | Keyframes | Duration | Usage |
|-------|-----------|----------|-------|
| `--animate-pulse-soft` | pulse-soft | 2s | Loading glows, live indicators |
| `--animate-shimmer` | shimmer | 2s | Skeleton loaders |
| `--animate-fade-in` | fade-in | 0.3s | Page loads, toasts, empty states |
| `--animate-slide-up` | slide-up | 0.25s | Modals, metric grids |
| `--animate-shake` | shake | 0.5s | Form errors (login) |

Respect `prefers-reduced-motion: reduce` in `index.css`; do not add unbounded animations.

## Typography

- **Primary font:** `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- **Monospace:** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` for counts, latency, API key prefixes, URLs, and status codes.
- **Scale:**
  - Page titles: `text-lg font-semibold`.
  - Card titles: `text-sm font-semibold leading-none`.
  - Body/table: `text-sm`.
  - Labels/captions: `text-[11px] font-medium uppercase tracking-wide` or `tracking-wider`.
  - Metric value: `text-[28px] font-semibold`.
  - Login title: `text-xl font-semibold`.
- **Line treatments:** `tabular-nums` for numbers; `leading-none` for tight headings; `leading-tight` for metric values; `tracking-tight` for large metric values.

## Spacing And Density

- Default section gap: `gap-4` (16 px); inline group gap: `gap-2` (8 px).
- Card internal padding: `px-5 py-4` to `px-6 py-6` depending on context.
- Table cell padding (DataTable): `px-4 py-3`.
- Table primitive cell padding: `p-2`.
- Button sizes:
  - Default: `h-9 px-4`.
  - Small: `h-8 px-3`.
  - Large: `h-10 px-6`.
  - Icon: `size-9`.
- Form input height: `h-10` to `h-11` (login inputs use `h-11`).
- Border radius: `--radius: 0.5rem`. Cards and containers use `rounded-lg`; small elements use `rounded-md`; icon containers use `rounded-xl` or `rounded-2xl`.

## Components

### Primitive source

Use the components in `apps/web/src/components/ui/`. Do not introduce new third-party UI libraries without explicit approval.

- **Button** (`button.tsx`): CVA-based with variants `default | destructive | outline | secondary | ghost | link` and sizes `default | sm | lg | icon`. Includes `active:translate-y-px`, focus ring, and `[&_svg]:size-4` defaults.
- **Card** (`card.tsx`): `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`. Default card has `gap-6`, `rounded-lg`, `border`, `py-6`, and `shadow-[var(--shadow-card)]` with hover shadow.
- **Table** (`table.tsx`): Wraps a scrollable container; header rows use `bg-surface-3` via parent styling; rows use `hover:bg-muted/50`.
- **Badge** (`badge.tsx`): Variants include `default`, `secondary`, `destructive`, `outline`, `success`, `warning`, `info`.
- **Select** (`select.tsx`): Radix-based, compact trigger (`h-7`), dark popover surface with `bg-surface-2`.
- **Skeleton** (`skeleton.tsx`): Shimmer loader over `bg-[hsl(230_9%_16%)]`.

### Custom components

- **PageLayout** (`PageLayout.tsx`): Standard page wrapper with icon, title, count, and actions.
- **DataTable** (`DataTable.tsx`): Generic typed table with column alignment, custom row hover accent bar, and empty state injection.
- **MetricCard** (`MetricCard.tsx`): Small card with uppercase label, icon badge, large value, and detail text.
- **MetricsGrid** (`MetricsGrid.tsx`): Five-column metric skeleton + metric card layout.
- **EmptyState** (`EmptyState.tsx`): Centered state with gradient icon container, title, description, optional action.
- **Pagination** (`Pagination.tsx`): Compact page numbers + first/previous/next/last + page-size selector.
- **FilterBar** (`FilterBar.tsx`): Dashboard-specific filter cluster with preset buttons and compact selects.
- **ConfirmDialog** (`ConfirmDialog.tsx`): Accessible alert dialog with focus trap, escape handling, and danger/warning variants. Uses `role="alertdialog"`.
- **ToastStack** (`ToastStack.tsx`): Top-center fixed stack for success/error toasts with icon-only dismissal.
- **PageSkeleton** (`PageSkeleton.tsx`): Full-page table skeleton for list views.

### Icons

- Use **lucide-react** exclusively. Default icon size is `size-4`; small action icons are `size-3`; page icons are `size-5`; metric icons are `size-3.5`.

### Dependencies to respect

- `@radix-ui/react-select` and `@radix-ui/react-slot` back the Select and Button `asChild` behavior.
- `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` support drag-to-reorder in the Configure page. Prefer these existing packages for future sortable UIs.

## Interaction States

- **Hover on cards:** subtle lift via `hover:shadow-[var(--shadow-card-hover)]` and/or background shift (`hover:bg-surface-3`).
- **Hover on rows:** `hover:bg-white/[0.03]` or `hover:bg-muted/50`.
- **Buttons:** `transition-all duration-150`, `active:translate-y-px active:shadow-none`, `focus-visible:ring-ring/50 focus-visible:ring-[3px]`.
- **Inputs:** `transition-all`, hover border `border-white/12`, focus `focus:border-ring focus:ring-2 focus:ring-ring/30`.
- **Focus:** visible ring only; do not suppress outlines globally.
- **Loading:**
  - Buttons show label change (e.g., "Saving...").
  - Refresh buttons use `animate-spin` on the icon.
  - Page content uses `PageSkeleton` or inline skeletons.
- **Disabled:** `disabled:opacity-50 disabled:pointer-events-none` for buttons; `disabled:opacity-40 disabled:cursor-not-allowed` for pagination controls.

## Responsive Behavior

- **Mobile first.** Sidebar collapses to a fixed top bar and slide-out drawer below `lg`.
- **Main content** gets `pt-14 lg:pt-0` to clear the mobile top bar.
- **Tables** are wrapped in `overflow-x-auto`; use `min-w-[...]` on inner tables to force horizontal scroll instead of squashing columns.
- **Metrics:** 1 col → 2 col (`sm`) → 5 col (`xl`).
- **Charts:** 1 col → 2 col (`lg`).
- **Filter bar:** 1 col → 2 col (`md`) → 4 col (`lg`).

## Accessibility

- Include a skip link (`skip-link`) as the first focusable element in the route tree.
- Use semantic landmarks: `<main>`, `<nav aria-label="Main">`, `<aside>`.
- Dialogs must trap focus, handle `Escape`, restore focus, and use `role="dialog"`/`role="alertdialog"` plus `aria-modal`.
- Charts need `role="img"` and descriptive `aria-label` text.
- Form inputs need associated `<label>` elements or `aria-label`.
- Respect `prefers-reduced-motion` by disabling animations.
- Focus states must be visible; do not suppress outlines globally.

## Implementation Rules

1. **Use Tailwind CSS v4 `@theme` tokens** in `index.css` for all new colors, shadows, and animations. Avoid hard-coding one-off HSL values in components.
2. **Prefer `cn()` from `@/lib/utils`** for conditional class composition.
3. **Use the `components/ui/*` primitives** for buttons, cards, tables, badges, selects, and skeletons. Extend them rather than duplicating styles.
4. **Custom form inputs are acceptable** when they follow the established pattern: `h-10`–`h-11`, `rounded-lg`, `bg-surface-1`/`bg-surface-3`, `border-white/[0.08]`, placeholder `text-muted-foreground`, hover/focus transitions.
5. **Page layout must use `PageLayout`** for consistent title/action/header spacing.
6. **Tables must use `DataTable` or `Table` primitives** and include an `EmptyState` when data is absent.
7. **Loading states:** use `PageSkeleton` for full-page loads, `Skeleton` for partial content, and inline spinner icons for button actions.
8. **Toast feedback:** use `useToast()` for all async success/error feedback instead of inline alerts, except for persistent form-level errors.
9. **Icons:** import from `lucide-react`; do not add new icon sets.
10. **Routes:** pages are lazy-loaded in `App.tsx`; add new pages inside the authenticated layout unless they are public. Remember the `/admin` basename.
11. **Sortable lists:** reuse the existing `@dnd-kit` packages already used in Configure; do not add new drag-and-drop libraries.
12. **EmptyState actions** currently use a custom button styled like `Button default`; prefer migrating to the `Button` primitive for consistency.

## Verification Checklist

Before considering Admin UI work complete:

- [ ] New page uses `PageLayout` and matches existing title/icon/count/action pattern.
- [ ] New components use `cn()` and Tailwind tokens from `index.css`.
- [ ] All buttons use the `Button` primitive (or justified exception documented).
- [ ] Tables use `DataTable` or `Table` primitives and include an `EmptyState`.
- [ ] Loading states are handled with `PageSkeleton`, `Skeleton`, or inline spinners.
- [ ] Async actions show toast feedback via `useToast()`.
- [ ] Focus states and keyboard navigation work; dialogs trap focus and close on `Escape`.
- [ ] Mobile layout does not break: tables scroll horizontally, sidebar collapses, content clears top bar.
- [ ] `npm run web:lint` and `npm run web:build` pass from the repository root.
- [ ] No new arbitrary HSL values duplicated in components; values come from `@theme` tokens.
- [ ] New dependencies are approved before being added.

## Source Evidence

- Color/theme/animation/shadow definitions: `apps/web/src/index.css`.
- App shell, basename, and routing: `apps/web/src/App.tsx`.
- UI primitives: `apps/web/src/components/ui/{button,card,table,badge,select,skeleton}.tsx`.
- Layout components: `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/PageLayout.tsx`.
- Page implementations: `apps/web/src/pages/{Dashboard,ApiKeys,Users,Configure,Login}.tsx`.
- Shared helpers: `apps/web/src/lib/utils.ts`, `apps/web/src/lib/routing.ts`.
- Feedback components: `apps/web/src/components/ToastStack.tsx`, `apps/web/src/components/ConfirmDialog.tsx`.
- Data display: `apps/web/src/components/DataTable.tsx`, `apps/web/src/components/MetricCard.tsx`, `apps/web/src/components/MetricsGrid.tsx`.

## Open Questions

- Should form inputs be migrated to a `components/ui/input.tsx` primitive for consistency?
- Is a light mode required for accessibility or operator preference?
- Should the design system include explicit dark-mode elevation tokens (e.g., shadow intensity per layer) beyond the current ad-hoc shadows?
- Should chart components adopt a shared wrapper with consistent aria-labels and loading states?
