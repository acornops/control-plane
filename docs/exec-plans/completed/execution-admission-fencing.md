# Execution admission fencing

User approved fixing the release blocker, verifying, and integrating the five
release-hardening repositories directly into main.

Use database reservation creation time, recorded under the workspace lock, for
run suspension ordering. Keep requestedAt as display/API metadata. Legacy runs
without authoritative admission records must be fenced by any suspension history;
rollout backfill must preserve that conservative ordering. No schema changes.

- [x] Reproduce skewed request times in native tools and maintenance, including
  valid post-restore admission and missing-reservation legacy runs.
- [x] Centralize canonical admission SQL; apply to execution access, native tool
  authority, cancellation/approvals/continuations and rollout legacy backfill.
- [x] Verify microsecond ordering, rollout and full control-plane validation.
- [x] Document legacy upgrade reconciliation and obtain independent review.

## Verification — 2026-09-07

The new regression cases failed before the fix (missing rejection, incorrectly
rejected post-restore admission, and missed maintenance cancellation). Afterwards,
the three targeted PostgreSQL files passed all 35 tests. The original test also
passes with the application's Date clock advanced by 60 seconds.

`npm run validate` passed all 1,313 tests and every subsequent gate. The explicit
`node --import tsx test/integration/capacity-replicas.ts` probe passed against
isolated engine main and disposable PostgreSQL/Redis: two control planes admitted
exactly 3/12 requests and two engines completed all four accepted cross-pool runs.
Independent read-only review found no blockers. Node 22 was not available as an
actual runtime (the installed node@22 path resolves to Node 24.2.0).

No API/schema migration is introduced. Unknown legacy admission uses conservative
ordering; previously backfilled ambiguous attempts require operator reconciliation
as documented in the runtime and deployment guides. Integration is authorized
directly to main in producer-first order; no deployment or image publication.
