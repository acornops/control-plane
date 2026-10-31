# Capacity maintenance status fix

Execute inline with systematic-debugging, test-driven-development, and one final
independent review. User authorized the focused repair and merging/pushing all
coordinated changes after thorough validation.

## Design and constraints

Maintenance must commit Workflow run transitions and execution aggregation in
the same transaction. Cover queue/lease expiry and the same direct suspension
transitions; preserve terminal outcomes, approval waits, latest-attempt selection,
and uncertain-operation capacity accounting. Recheck expiry under reservation
and run locks so a stale candidate cannot fail newly started work. Lock
contention must roll back safely and remain retryable by a later maintenance tick.

Reconcile at most 200 stale nonterminal summaries per tick when the latest root
is terminal with a maintenance error. Reuse the existing aggregate function and
never requeue or redispatch while repairing history. No schema, authorization,
engine protocol, or customer-data migration changes.

## Plan

- [x] Add real PostgreSQL regressions for expiry with capacity on/off and
  pending/delivered dispatch, aggregate rollback, stale-summary repair,
  newer/terminal attempt protection, approvals, suspension, and start races.
- [x] Observe expected failures, implement atomic transitions/reconciliation,
  and pass focused tests including existing capacity/dispatch suites.
- [x] Run full control-plane validation and a fresh-context independent review.
- [ ] Update debt/operations records and existing PR scope; check CI on final heads.
- [ ] Merge runtime and mirrored contracts, publish the compatible runtime image
  required by the deployment cleanup, update/test pins, and merge remaining PRs.
- [ ] Verify remote main commits and remove only disposable test infrastructure.

## Release ruling

The user explicitly authorized all changes to be merged and pushed. Completing
the already documented deployment dependency requires publishing a new compatible
control-plane image before merging deployment templates. Use the next available
tag only after successful CI; do not deploy any running environment or publish a
new platform chart as part of this request.

## Evidence and review focus

The old implementation directly updates `workflow_runs`, then settles capacity,
without invoking execution aggregation. All three maintenance transition sites
have this omission. Existing aggregate logic correctly selects the newest root,
preserves terminal execution states, and accounts for required-child approvals.
Review lock ordering against approval/resume/cancellation and preserve capacity
until uncertain operations finish. Historical reconciliation must stay bounded
and must not revive old attempts or repeatedly select unrepairable rows.

## Review and regression ledger

- Nine expected failures reproduced missing aggregate updates, delivery cleanup,
  and rollback before implementation; the initial fix passed 48 focused tests.
- A real-lock regression found historical repair stopped at a locked execution.
  Selecting up to 200 executions with `SKIP LOCKED` repaired other records and
  picked up the locked record on a later tick.
- The independent review found one P1: making an expired root resumable without
  stopping its old specialists could overlap old and new attempts. Accepted and
  fixed before merge. Shared the existing root-terminal child cleanup with the
  commit path, revoked child capacity in the same transaction without releasing
  uncertain-operation charges, and requested engine cancellation after commit.
- Both live-expiry and historical-repair child regressions failed first and then
  passed. They verify approval/continuation cleanup, delivered-outbox preservation,
  safe explicit retry, capacity retention, and rollback with no premature external
  cancellation when the aggregate update fails. Final focused suite: 59 tests;
  expanded maintenance regression file: 16 tests, all passing.
- Review rulings: production-scale query benchmarking remains outside this
  focused repair; writes are bounded and root-attempt indexes exist. Lock
  contention remains retryable, with no persistent starvation reproduced.
  Existing suspension and terminal-state policies remain unchanged except for
  the required atomic aggregation and child termination.
- Final `npm run validate` passed: 1,539 tests, typecheck, style/architecture,
  authorization, contracts, OpenAPI, harness, and build. Fresh isolated integration
  startup passed; control-plane readiness, engine health, and gateway health all
  returned 200. The disposable integration stack was removed afterward.
- Tightened the historical repair regression to 202 records with one locked,
  proving both the 200-record batch limit and progress past lock contention.
- Exact-head CI and release/merge evidence are tracked in PR #32.
