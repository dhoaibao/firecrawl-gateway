# Phase 5 — Recurring Quota and Capacity Control

Depends on: Phase 2 and Phase 4
Release gate: complete before public registration or included tenant traffic is enabled

## Product rules encoded by this phase

- Default permanent commitment: 100 requests per UTC calendar month.
- Admission requires verified account, active account status, and available permanent commitment capacity.
- Admitted accounts retain the commitment until explicit free-tier revocation.
- Suspended/blocked accounts cannot receive or spend a monthly entitlement, but suspension does not free the permanent slot.
- Waitlisted accounts may use BYOK.
- Unused allowance expires; no rollover.
- Included usage counts once after an operator-infrastructure dispatch, not per retry.

## Tables and state machines

### `free_tier_policy`

Singleton/versioned policy with:

- default grant
- permanent commitment ceiling
- hard monthly consumption ceiling
- committed amount
- new-admissions enabled flag
- warning thresholds
- scheduled next-period changes
- update version/timestamps/operator actor

### `free_tier_enrollments`

Per account:

- `waitlisted` -> `enrolled` -> `revoked`
- grant amount committed for future periods
- admitted/waitlisted/revoked timestamps and operator reason
- suspended account status is not duplicated here

### `quota_periods`

UTC period start/end, hard cap, reserved, consumed, status (`open`, `paused`, `closed`).

### `account_entitlements`

Account + period unique row with allocated, reserved, consumed, status, and enrollment snapshot.

### `usage_reservations` and `usage_events`

Request-id/idempotency keyed reservation lifecycle and immutable final charge/adjustment record. Manual adjustments never rewrite history.

## Steps

### 1. Implement concurrency-safe permanent admission

Within one PostgreSQL transaction:

1. Lock/update the policy row.
2. Atomically increment `committed_amount` only when `committed + grant <= commitment_ceiling` and admissions are enabled.
3. Insert `enrolled`; otherwise insert `waitlisted` without incrementing commitment.
4. Create the current-period entitlement for newly enrolled active accounts.
5. Insert audit/outbox events.

Use unique constraints and idempotency so verification retries cannot reserve twice.

Done when:

- A high-concurrency verification test never pushes commitments above the ceiling.
- Exactly the allowed number of accounts enroll; the rest are deterministically waitlisted.
- Admission retry returns the existing result without changing counters.

### 2. Implement permanent-slot lifecycle

- Suspension immediately blocks use and skips new entitlement issuance, but leaves enrollment and committed amount unchanged.
- Reactivation resumes the remaining current entitlement or creates one for the current period if none exists.
- Explicit `revoke free-tier eligibility` changes enrollment to revoked, decrements commitment transactionally, blocks included use, and emits an audit event.
- A revoked account may be manually re-enrolled or waitlisted according to current capacity.
- Operators cannot lower the commitment ceiling below `committed_amount`; emergency override is a separate, strongly confirmed operation that pauses/changes service rather than corrupting counters.

Done when:

- Suspend/reactivate never double-allocates or frees a permanent slot.
- Revocation releases exactly the account's committed amount once.
- State transition and concurrency tests cover every pair of simultaneous admin/user events.

### 3. Create monthly periods and entitlements idempotently

- Worker opens the next UTC month and inserts entitlements for enrolled, verified, active accounts.
- Unique `(account_id, period_start)` prevents duplicates.
- API lazily ensures a missing current entitlement as a recovery path; correctness does not depend on one cron execution.
- Suspended accounts are skipped. Reactivation can invoke the same idempotent ensure operation.
- Policy changes apply either immediately to future admissions or through an explicit next-period schedule for existing enrollments.

Done when:

- Multiple workers/restarts create exactly one entitlement per eligible account/month.
- Month-boundary tests use an injected clock and cover leap year/year rollover.
- Unused prior-period requests cannot be spent.

### 4. Reserve and finalize included requests atomically

Before dispatch:

- Authenticate and validate first.
- Atomically reserve one account request only if `consumed + reserved < allocated`.
- Atomically reserve one platform request only if period hard-cap headroom exists and period/source is open.
- Insert reservation keyed by gateway request ID.

After dispatch:

- Finalize reservation to consumed exactly once if any operator upstream dispatch occurred.
- Release it if failure happened before dispatch.
- Internal retries/fallbacks remain attached to the same reservation.
- A worker reconciles expired in-flight reservations. If dispatch may have happened, charge conservatively; otherwise release.

Done when:

- Concurrent requests cannot exceed account allocation or platform hard cap.
- Crash/retry/finalize races never charge twice.
- Pre-dispatch validation failures do not consume quota; dispatched upstream errors do.

### 5. Integrate BYOK and funding preference

- `byok`: requires healthy user credential; never reserves included quota.
- `included`: requires entitlement and operator source; fail without silently using user BYOK unless product policy explicitly permits.
- `auto`: follow documented account preference (recommended: BYOK first, included fallback) and report which funding class was used without exposing credentials.
- Suspended/blocked status rejects all three modes.

Done when:

- Funding-mode matrix is covered for missing, invalid, rate-limited, and healthy credentials/sources.
- BYOK usage never changes included counters.

### 6. Process the waitlist safely

- Worker claims oldest eligible waitlist rows with `FOR UPDATE SKIP LOCKED`.
- Stop immediately when the next grant cannot fit or admissions are paused.
- Recheck verified/active status at claim time.
- Support operator preview, manual admit, automatic admit, and skip-with-reason.
- Capacity increases emit a waitlist-processing event; decreases never revoke existing seats automatically.

Done when:

- Multiple workers preserve FIFO among claimable rows and never overcommit.
- Suspended/unverified rows are not admitted.
- Adding capacity admits only the number of permanent commitments that fit.

### 7. Add operator controls and safeguards

- Set default grant for future admissions.
- Schedule existing grant changes for a future period with a commitment-impact preview.
- Set commitment ceiling and hard usage ceiling independently.
- Pause new grants, included traffic globally, or individual sources.
- Grant/reduce individual allowance through ledger adjustments bounded by platform policy.
- Display committed, allocated, reserved, consumed, remaining slots, waitlist, and projected exhaustion.

Done when:

- Every control validates its invariant server-side and records actor, reason, before/after values.
- UI/API cannot submit a value that makes committed or consumed counters invalid.

### 8. Emit threshold and exhaustion events

Emit deduplicated events for:

- Configured committed-capacity thresholds.
- Fewer than N permanent slots remaining.
- Consumption thresholds and projected early exhaustion.
- Hard cap reached.
- Waitlist growth.
- Source budget/concurrency/health pressure.

Phase 7 renders and delivers these notifications; Phase 5 owns detection and deduplication keys.

Done when:

- Repeated requests above one threshold produce one open notification per period/policy version.
- Crossing a higher threshold produces a new event.

## API behavior

- Return a stable machine-readable error code for account allowance exhausted, platform hard cap, grants paused, and waitlisted/no entitlement.
- Include current-period limit/remaining/reset metadata on authenticated data-plane responses.
- Do not reveal global capacity values to ordinary users beyond service availability.

## Verification

- Property/state-machine tests for enrollment, suspension, revocation, and period issuance.
- Real-PostgreSQL concurrency tests for admission, reservation/finalization, waitlist claims, and admin updates.
- Crash-recovery tests for stale reservations and worker retries.
- End-to-end fake-upstream tests proving one charge per externally dispatched client request.
- Analytics reconciliation: ledger sum must equal denormalized counters.

## Operational invariants

Provide a read-only reconciliation command that reports mismatches but never repairs automatically. Repairs require an operator-reviewed ledger adjustment/migration.
