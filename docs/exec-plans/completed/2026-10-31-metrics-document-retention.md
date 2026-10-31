# Bounded admin metrics and expired document cleanup

## Scope

Bound admin request metric labels at the counter boundary to declared admin/admin-auth
route templates, eight method labels, and HTTP status codes. Preserve parameterized
templates using tuple keys; keep authentication and response behavior unchanged.

Delete generated documents only when their existing `retention_expires_at` has passed.
Use the existing expiry index and retention worker: at most twenty 500-row batches
per sweep, row locks with `SKIP LOCKED`, and a five-second statement timeout per batch.
No migration, new setting, new dependency, workflow-history retention policy, or TLS work.

## Steps and acceptance

- [x] Reproduce metric growth and template corruption with failing tests.
- [x] Bound labels; test both actual routers, unknown paths/custom methods, template
  fidelity, and parity between declared routes and allowed metric labels.
- [x] Reproduce missing document cleanup; test expiry boundaries, both document scopes,
  unchanged parent/unexpired records, batch limits, concurrent locks, and error isolation.
- [x] Run targeted tests and `npm run validate` with isolated PostgreSQL/Redis.
- [x] Independently review the final changes before committing.

## Review focus

No raw paths or arbitrary labels retained. Matched route templates and totals survive
rendering. Expiry uses database time and deletion cannot cascade upward to parents.
Cleanup respects locked rows and bounded work; later retention tasks still run on failure.

## Evidence

Implemented on `fix/production-followup`, on top of issue-observation retention
commit `318eaa9`. No schema changes or new settings/dependencies.

- New metric regressions failed before the fix; both metrics suites passed 16/16.
- New cleanup regressions failed before the fix; database/worker suites passed 10/10.
- `npm run validate`: 1,538 tests passed, zero skipped; migration SQL, authorization,
  membership, run-event, contracts and OpenAPI checks passed. The first pass reached
  the harness and caught its trailing-newline file-length count. Removed spare
  whitespace in the repository facade; `npm run harness:check` and `npm run build`
  passed afterward. The final complete `npm run validate` passed with all 1,538
  tests, zero failures/skips, every guard, and the production build.
- Independent review found no Critical/Important issues. Corrected placement of the
  existing vacuum guidance while finishing the operations documentation.
- No customer data cleanup or production deployment performed. Expired document
  deletions cannot be undone by rolling back application code; workflow-history
  retention remains separate.
