# Target Insights checkpoint request and retries

Restore the existing gateway request contract and stop repeated failed checkpoints
for unchanged session activity. Keep gateway authority, instructions, model policy,
leases and public contracts unchanged.

- [x] Reproduce the legacy request and unbounded retry defects with focused tests.
- [x] Send `runtime_instruction` and a canonical user `transcript` turn.
- [x] Keep bounded HTTP status information; make 4xx except 408/429 terminal.
- [x] Stop retrying failures after three claimed attempts. Refund claims deferred
  for idle time, active work, state changes or capacity so earlier failures remain
  counted. Refund a duplicate claim before ending a sweep, and refund recoverable
  configuration skips when settings changes requeue them. New session activity
  continues to reset attempts.
- [x] Verify persisted counts, stale leases and new activity with isolated Postgres.
- [x] Run `npm run validate`, update product documentation and capture a synthetic
  request for validation against the unchanged gateway schema.

No migration, new event or contract manifest update is needed: this restores the
existing gateway body and uses the existing checkpoint attempts column.

Focused checks pass, including canonical request shape, safe failure diagnostics,
three-attempt cutoff, deferred-claim refunds, repeated settings skips and renewed
eligibility after new activity. The emitted synthetic body passed the unchanged
gateway model and ASGI route with no real provider request.

An initial canonical run passed 1,782 tests with no failures or skips. Review
identified the settings-requeue refund, which now passes its three additional
real-store regressions. Final `npm run validate` passed 1,785 tests across 260
suites with zero failures or skips, plus typecheck, style, SQL migration checks,
authorization, membership, event durability, contracts, OpenAPI, harness and
build. The generated OpenAPI inventory path was supplied explicitly.

The final control-plane image matched the five changed production files;
control-plane readiness, gateway health and execution-engine health returned
HTTP 200. Independent review found no remaining issues after the settings-requeue
correction. Release and demo rollout are tracked in the coordinated release record.
