# Terminal-safe dispatch recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. The user authorized implementation on 2026-10-30. Runtime rollout remains separate release work.

**Status:** Implemented locally on `fix/high-priority-defects`; local regression and integration-startup checks passed. Fleet rollout and live dropped-response canary remain open. The record below supersedes the original proposed interfaces and unchecked tasks.

## Implementation record — 2026-10-30

- [x] New `repository-workflow-dispatch.ts` prepares and settles a current claim atomically. Execution/run/outbox locks use NOWAIT with bounded database-only contention retries. Network requests remain outside the transaction; persistence errors cannot become transport failures.
- [x] The worker uses a unique token per claim, claims just before delivery, covers configured HTTP timeout with the lease, preserves callback/cancellation/approval/review evidence, and keeps the existing transport identity, three-attempt limit, safe-drain treatment and exponential backoff.
- [x] Retry exhaustion updates eligible run, outbox and execution aggregate together. Already-progressed expired claims settle through the existing claim path without another HTTP dispatch or attempt charge. Metrics follow accepted outcomes; stale workers cannot settle or trigger cancellation.
- [x] Actual PostgreSQL tests cover completed/failed/cancelled roots and children through `commitRun`, observed running/approval/review states, cancellation, claim replacement, expiry, long timeout, two-client contention, aggregate rollback and acknowledgement-persistence failure.
- [x] Independent final review found no additional H3 correctness defect. Initial new regressions failed 14 cases with 4 controls passing; implementation corrected the failures. The 43-test recovery/dispatch/approval/capacity group passed. Twelve deterministic race cases passed in each of 20 repetitions (240 passes).

**Critical plan adjustments:** Reuse the existing claim/preparation path for expired progressed rows instead of adding another reconciler; recovered rows consume the existing tick limit. Keep one narrow `settleWorkflowDispatch` interface instead of separate preparation/result types and reconciliation APIs. Preserve existing capacity and uncertainty/resume policy, with no new reservation-authority classifier or maintenance changes. That avoids turning a state-regression correction into a new admission/replay policy; unobserved acceptance retains the existing uncertainty limitation. No schema, protocol, engine or schedule change is included.

**Validation:** `npm run validate` passed 1,501 tests with no failures/skips after H1/H3 review fixes, plus typecheck/style/migrations/authz/membership/run-events/contracts/OpenAPI/harness/build. Final `npm run validate:ci` passed all 1,501 tests with coverage after the scanner performance correction, with no failures or skips. The targeted command was `NODE_ENV=test node --import tsx --test --test-concurrency=1 test/workflow-dispatch-recovery-postgres.test.ts test/dispatch-capacity-postgres.test.ts test/workflow-run-approvals-postgres.test.ts test/workspace-capacity-fixes-postgres.test.ts`. All database fixtures used task-owned PostgreSQL 16/Redis 7 stores with an explicit `_test` database and matching `DATABASE_URL`/`CONTROL_PLANE_TEST_DATABASE_URL`.

The documented Compose integration profile built and reached healthy control-plane, execution-engine, gateway, Postgres and Redis services in the separate `acornops-high-defects-20261030` project. Temporary overrides used fresh project volumes, synthetic configuration and ephemeral loopback ports. This is integration startup/readiness evidence; dropped-response races were exercised by the real-Postgres/controller harness with a mocked HTTP response, not a live agent/provider run.

**Remaining release work:** Qualify the live engine/agent dropped-response canary before promotion and upgrade every worker replica. Historical inconsistent records are not automatically repaired. Existing resume and reservation policy are unchanged; this does not promise exactly-once external effects. No release image, deployment pin or production service was changed.

## Original proposed plan

The remaining unchecked tasks preserve the original proposal; the implementation record identifies narrowed interfaces and intentionally deferred policy/operational work.

**Goal:** Preserve authoritative Workflow state when an execution-engine dispatch response is lost, including the third failed delivery attempt.

**Architecture:** Settle each claimed dispatch outcome in one short Postgres transaction using current run state and a unique claim token. Reuse existing outbox statuses, aggregate derivation, execution idempotency, and capacity maintenance; keep network requests outside database transactions.

**Tech Stack:** TypeScript, Node.js 22+, node:test, PostgreSQL 16, existing pg client and execution-engine HTTP client.

**Spec:** This document's behavior specification and transition table; [reliability rules](../../RELIABILITY.md), [architecture](../../../ARCHITECTURE.md), and [development guide](../../DEVELOPMENT.md).

**Reviewed baseline:** `93f1a05ef15a27e724ce04e8664a8999002cf577` on 2026-10-30, including the current working tree. Existing offline-agent plan edits belong to the user and remain intact. Rebase the file/function map against the implementation checkout before starting.

## Global constraints

- Documentation only in this planning change; no product edits, migrations, services, deployments, commits, or remote writes.
- Implementation scope is Workflow dispatch delivery/recovery. Schedule mutation races, historical reads, capacity admission, conversation dispatch, and monetary budgets have separate owners.
- Keep run IDs, execution IDs, payloads, and idempotency keys unchanged on delivery retry. Never create a replacement execution/root attempt automatically.
- Preserve terminal state, cancellation intent, approval state, output, usage, timestamps, and existing uncertain-write evidence.
- Use existing schema unless a concrete failing regression proves that it cannot represent the required fencing; any migration requires a separately reviewed design change.
- Run database tests only against explicitly isolated test stores; fixture reset truncates workspace data.

## Review focus

1. A callback commits before a failed HTTP response: output and terminal state must survive; Task 1.
2. Cancellation or approval changes state between dispatch and settlement: delivery recovery must not restart work; Task 2.
3. The same process reclaims an expired lease: an old completion must not match the new claim; Task 3.
4. Database failure interrupts outcome persistence: no partial run/outbox/aggregate update or false success metric; Task 4.
5. Dispatch exhaustion and uncertain writes retain their existing recovery meanings: preserve the uncertainty flag and existing resume behavior; Tasks 1 and 4.

## Current behavior and defect

`src/services/automation-outbox-worker.ts::retry()` writes the outbox first, then calls the unrestricted `updateWorkflowRun()` with `needs_review`, then recomputes the aggregate in another transaction. `deliver()` only conditionally resets `dispatching` to `queued` before that call.

An engine can commit `completed` while its dispatch request is still outstanding; the success path already acknowledges this ordering. If the third response is lost, the conditional reset preserves completion, but the subsequent unrestricted update changes the run to `needs_review`. Aggregate recomputation preserves the completed execution, producing contradictory records. A fully mocked control-flow reproduction confirmed this ordering during the 2026-10-30 review; actual Postgres race coverage is required before shipping.

Related same-row weaknesses matter to this fix: failure updates do not verify `claim_owner`; the owner is currently constant for the process; claimed rows are handled serially with a fixed five-minute lease; success metrics ignore whether the fenced update accepted the claim.

### Scope boundary

- **Essential defect protection:** restrict failure-induced run transitions to currently eligible state under a database guard and commit run/outbox/aggregate changes atomically. This prevents response loss from replacing callback state or leaving contradictory recovery records.
- **Supporting ownership protection:** unique per-claim tokens and guarded same-row settlement prevent an expired worker from applying that transition to another worker's claim. Both success and failure paths need the same check.
- **Supporting recovery:** just-in-time claims avoid ageing a serial batch; narrow expired-row reconciliation closes this worker's outboxes after callbacks that ordinary claims already exclude. It does not inspect unrelated queues, repair historical run corruption, or launch replacement executions.
- **Supporting evidence:** database race/rollback tests and committed-outcome metrics prove that these boundaries hold under the demonstrated failure order. Reuse existing counters and capacity cleanup; do not add a queue framework, generic retry library, new delivery schema, or new operator policy.

## Behavior specification

The database state observed under settlement locks wins over the worker's pre-request snapshot. HTTP acknowledgement proves acceptance, not `running`; only the existing start-event path changes that state. A failed response does not prove execution failed or never started.

| Current durable condition | Owned HTTP success | Owned HTTP failure | Run/aggregate treatment |
| --- | --- | --- | --- |
| Claim missing, replaced, expired, or no longer claimed | `stale_claim` | `stale_claim` | No mutation or cancellation by stale worker |
| Run `completed` or `failed` | Close outbox `delivered` | Close outbox `delivered`, recovered outcome | Preserve all fields; reconcile aggregate with existing terminal precedence |
| Run `cancelled`, `cancelling`, or cancellation intent present | Close outbox `cancelled` | Close outbox `cancelled` | Preserve state and intent; existing cancellation owner finishes cleanup |
| Run `running` or `waiting_for_approval` | Close outbox `delivered` | Close outbox `delivered`, recovered acceptance | Preserve running/approval state, continuation, and grants |
| Run already `needs_review` | Close outbox `needs_review` | Close outbox `needs_review` | Preserve its reason, `uncertain_write`, and review requirement |
| Run `queued`/`dispatching`, no cancellation, ordinary failure count becomes 1 or 2 | Close outbox `delivered`; keep run state | Outbox `failed`, eligible run `queued` | Retry same identity after existing backoff |
| Same condition, ordinary failure count becomes 3 | Close outbox `delivered`; keep run state | Outbox/run `needs_review` | Set `DISPATCH_RETRIES_EXHAUSTED`; recompute aggregate atomically |
| Same condition, exact safe-drain rejection | Close outbox `delivered` if acknowledged | Outbox `failed`, eligible run `queued`; no attempt charge | Existing drain retry behavior remains |
| Eligible-looking run but live executing capacity authority exists | Close outbox `delivered` | Recover acceptance; no exhaustion/reset | Preserve authority and run state; do not settle active execution |

Cancellation intent takes precedence over nonterminal progress; an already terminal `completed`/`failed` record remains terminal even if historical intent is present. Test and document this precedence explicitly. A missing run closes an owned orphan outbox `cancelled`; it cannot create state.

`attempt_count` records committed delivery outcomes under current ownership: increment by one for ordinary success/failure, zero for safe drain, stale claim, deferral, database rollback, or reconciliation without an HTTP attempt. Compute from the locked row, never a stale claim snapshot. Apply the limit only to an eligible `queued`/`dispatching` run without live execution authority. Preserve `Math.min(30, 2 ** attempt)` seconds and the three-failure threshold.

No count can prove how many HTTP requests occurred across a crash before persistence. Preserve at-least-once transport and the same engine idempotency key; do not promise exactly-once external effects or invent compensating writes.

### Preserve existing `needs_review` and resume semantics

Today `resumeWorkflowExecution()` accepts `failed`/`needs_review` and creates a new root attempt, but rejects `uncertain_write=true`. Approval uncertainty sets that flag; dispatch exhaustion currently does not. Capacity maintenance also considers `needs_review` eligible for settlement.

The chosen compatibility behavior is to retain `needs_review` for exhausted, still-dispatchable transport work, preserve any existing uncertainty flag unchanged, and never apply exhaustion to observed execution/approval/terminal state. Do not set `uncertain_write` solely because a dispatch response was lost. Existing authorized resume eligibility and the `uncertain_write=true` rejection remain unchanged. Pin both with regressions; they are decided behavior for this fix, not an implementation gate.

Redesigning whether transport uncertainty should block a new-root resume until write absence is proven is explicitly deferred to a separate policy change. Absence of a callback still does not establish absence of effects. This plan provides no automatic new-root replay, historical mass repair, or new assurance about operator-initiated retries.

## File and function map

| File | Responsibility in implementation |
| --- | --- |
| `src/services/automation-outbox-worker.ts` | `claim`, `deliver`, `retry`, `runAutomationOutboxTick`: thread claim token through each path; separate HTTP outcome from persistence failure; emit accepted outcomes only |
| New `src/store/repository-workflow-dispatch.ts` | Own narrow claim preparation, atomic outcome settlement, expired-claim reconciliation, and typed outcomes |
| `src/store/repository-workflow-execution-aggregate.ts` | Reuse `recomputeWorkflowExecutionStatus(client, runId)` inside settlement; retain terminal aggregate precedence |
| `src/store/repository-run-capacity.ts` | Read existing reservation authority; reuse `settleRunCapacity` only outside settlement through existing maintenance; no admission redesign |
| `src/services/workspace-capacity-maintenance.ts` | Existing `maintainWorkspaceCapacity` remains the durable reservation cleanup owner; change only if a regression proves recovery cannot finish |
| `src/metrics.ts` | Existing dispatch counter/duration helpers; bounded `recovered`/`deferred` outcome labels if needed |
| New `test/workflow-dispatch-recovery-postgres.test.ts` | Database-backed outcome matrix, lock/race barriers, rollback, reclaim, and maintenance assertions |
| `test/dispatch-capacity-postgres.test.ts` | Retain acknowledgement/dispatch-gate/drain regressions; share fixture setup rather than duplicate it |
| `test/helpers/automation-database-fixtures.ts`, `test/helpers/workflow-delegation-postgres-fixtures.ts` | Reuse isolated reset, `coordinatedRoot`, and delegation fixtures; add a small direct-root fixture only if necessary |
| `docs/RELIABILITY.md`, `docs/OPERATIONS.md`, `docs/QUALITY_SCORE.md` | Record state precedence, response-loss recovery, operator inspection, and actual validation evidence |

Proposed interfaces in the new repository module:

- `WorkflowDispatchClaim`: outbox/run/workspace/execution IDs, idempotency key, unique `claimOwner`, persisted attempt count, expiry.
- `WorkflowDispatchPreparation`: `{ kind: 'ready'; run: WorkflowRunRecord } | { kind: 'settled'; settlement: WorkflowDispatchSettlement }`.
- `prepareWorkflowDispatch(claim: WorkflowDispatchClaim): Promise<WorkflowDispatchPreparation>`: recheck owned, unexpired claim and current eligibility immediately before HTTP; conditionally transition queued to dispatching. Progressed rows settle as observed, without inventing an HTTP attempt.
- `settleWorkflowDispatch(claim: WorkflowDispatchClaim, outcome: { kind: 'acknowledged' } | { kind: 'failed'; safeDrain: boolean; message: string } | { kind: 'observed' }): Promise<WorkflowDispatchSettlement>`.
- `WorkflowDispatchSettlement`: `{ outcome: 'delivered' | 'recovered' | 'retry' | 'needs_review' | 'cancelled' | 'stale_claim' | 'deferred'; attemptCount?: number }` returned only after commit.
- `reconcileExpiredWorkflowDispatchClaims(limit: number): Promise<number>`: close expired rows whose current run already progressed; leave eligible queued/dispatching rows reclaimable with a fresh token.

## Transaction and ownership design

1. Generate a fresh random claim token for each claim operation, including same-process reclaim; store it in existing `claim_owner` and return it with the row. Instance ID is diagnostic context, not the fence.
2. Claim one row immediately before processing, up to the tick's existing limit; do not leave a serial batch ageing behind network requests. Preserve `SKIP LOCKED`, runtime gates, and service lifecycle admission.
3. Before HTTP, validate ownership/expiry and run eligibility transactionally. For an already progressed run, settle locally and make zero dispatch requests. Set lease duration to `max(300000, EXECUTION_ENGINE_TIMEOUT_MS + 30000)` milliseconds, reserving 30 seconds for settlement; do not renew an expired/replaced claim.
4. Settlement reads identity, then locks execution, run, and outbox in that order. Use `FOR UPDATE NOWAIT` for these locks: cancellation uses execution→run→outbox, while existing approval writers can hold run before aggregate. Do not introduce another waiting lock cycle.
5. On `55P03`/`40P01`, roll back and retry the entire database-only settlement at most three times with bounded 25/100 ms delays. Never repeat the HTTP request inside that retry. If contention persists, return/log deferred persistence and let expired-claim recovery reconcile durable state.
6. After locks, verify exact token, `claimed` status, and expiry with `clock_timestamp()`. Lock/read the reservation without waiting only when authority affects classification; an unavailable authority row defers rather than guessing it is inactive. Do not acquire workspace locks or invoke nested capacity transactions here.
7. Mutate eligible run/outbox and invoke aggregate recomputation on the same `PoolClient`. Existing terminal aggregate precedence wins; a terminal aggregate with an incompatible nonterminal run must defer for operator reconciliation rather than reopen it.
8. Commit before emitting outcome metrics or making a best-effort cancellation call. Only an owned cancellation outcome may request engine cancellation; a stale worker must never cancel the successor's accepted execution.
9. Persistence errors remain persistence errors. Do not catch a failed settlement and call the transport-failure path again. A rollback preserves claim/run/aggregate and emits no success/retry/exhaustion outcome counter.
10. Expired-row reconciliation runs before ordinary claims. Under the same nonwaiting lock order, recheck expiry and current progressed state, replace the expired owner with a fresh token, and settle the observed outcome atomically without HTTP or an attempt charge. It handles a worker crash after a start/terminal callback even though ordinary claims exclude running/terminal runs. Eligible queued/dispatching rows remain for ordinary reclaim. Repeat safely; never manufacture a callback or dispatch another identity.

The SQL status predicate is the essential fix; ownership and transaction boundaries prevent the same recovery path from reintroducing it. The narrow NOWAIT policy addresses an existing ordering conflict: `cancelWorkflowExecutionGraph()` and `advanceWorkflowExecution()` lock execution before runs, while approval `markNeedsReview()`/`setWaitingForApproval()` update the run before calling aggregate recomputation. Merely locking outbox then updating run also conflicts with cancellation's run→outbox order. A settlement-only nonwaiting acquisition avoids widening this task into a rewrite of those writers. If actual DB regressions establish a simpler common order that cannot form a cycle, prefer that and record the evidence; do not add a global retry framework.

Capacity remains eventually settled by `runWorkspaceCapacityMaintenance()`: terminal and genuine review records are already selected there; `settleRunCapacity()` retains charges while a lease/operation is live. Dispatch settlement must not release capacity directly or clear owners/generations. Test both eventual cleanup and active-operation retention.

## Tasks

### Task 1: Pin callback precedence with Postgres regressions

**Files:** New recovery test; existing dispatch test and fixture helpers; repository module interface above.

- [ ] Add compatibility assertions: transport exhaustion preserves `uncertain_write` unchanged; existing authorized resume still accepts the same eligible review states and rejects `uncertain_write=true`. Do not change resume policy.
- [ ] Add `third response failure preserves committed outcome` for completed/failed/cancelled roots and specialist children. Seed attempt count 2, hold the HTTP stub on an explicit promise barrier, commit callback state through `commitRun()` using another DB connection, then reject the response.
- [ ] Assert run status/output/usage/timestamps/error evidence remain identical; root aggregate remains terminal, child aggregate follows required-child rules; no new execution, message, run, approval, or idempotency key appears.
- [ ] Add failures after `run_started` and approval creation: invoke real controller/repository transitions, then reject HTTP; assert `running`/`waiting_for_approval`, first start timestamp, continuation, and approval grant survive.
- [ ] Run the targeted command below and confirm the completed/third-attempt test fails on current code for the observed state mismatch, not fixture/setup errors.
- [ ] Implement minimal state-aware `settleWorkflowDispatch()` with same-transaction aggregate update; replace unrestricted failure updates; rerun matrix to green.

### Task 2: Make outcomes atomic and cancellation-safe

**Files:** Repository module; worker `deliver`/`retry`; recovery tests.

- [ ] Add table-driven real-DB tests for attempt counts 0/1/2, success, ordinary failure, exact safe drain, pre-existing needs_review, and missing run; assert every table row and exact stored count/backoff/status.
- [ ] Add cancellation race barriers before and during settlement: set `cancellation_requested_at` while status remains dispatching, run `cancelWorkflowExecutionGraph()` concurrently, and reverse winner order. Assert no cancellation intent is cleared and no cancelled record becomes queued/review/running.
- [ ] Add queued/dispatching with an old `started_at` from approval continuation: decide from current state/authority, not whether a timestamp exists; retain same run and continuation semantics.
- [ ] Add live executing-reservation/delayed-start-event case: HTTP failure never triggers exhaustion or direct settlement; later callback is accepted normally.
- [ ] Implement NOWAIT lock ordering and bounded database-only retries. Use two real `PoolClient`s and `pg_blocking_pids`/explicit barriers to assert lock contention defers or completes without a deadlock or duplicate HTTP invocation; no sleeps as race coordination.
- [ ] Assert transaction visibility: another connection sees either the old run/outbox/aggregate tuple or the new tuple, never a partially committed exhaustion result. Rerun targeted tests.

### Task 3: Fence claims and recover worker loss

**Files:** Worker claim loop; repository preparation/reconciliation; recovery tests.

- [ ] Add same-process and two-worker reclaim tests: pause worker A, expire its lease with SQL, claim with B, then release A's success/failure. Assert A mutates zero rows, charges zero attempts, emits only stale outcome, and never cancels B's run.
- [ ] Use barriers to prove `prepareWorkflowDispatch()` rejects an expired claim before HTTP, rejects terminal/approval/cancellation changes, and dispatches an eligible current claim exactly once in that tick.
- [ ] Implement unique per-claim tokens and just-in-time single-row claims; recheck service/runtime gates between claims. Keep the existing per-tick limit and engine idempotency payload.
- [ ] Test configuration where timeout exceeds five minutes by inspecting computed lease deadline, not waiting in real time; it must cover timeout plus the settlement allowance. Test expiry during a suspended process still fences completion.
- [ ] Add crash-after-callback fixtures with expired claimed outboxes for running, approval, completed, failed, cancelled, and needs_review states; reconcile without HTTP and without changing run evidence. Eligible work remains reclaimable under a new token.
- [ ] Assert repeated reconciliation is a no-op and ordinary retry repeats the same payload/idempotency key. Rerun recovery and existing dispatch tests.

### Task 4: Verify persistence failures, capacity, and operational evidence

**Files:** Recovery tests; worker metrics handling; reliability/operations/quality docs.

- [ ] Add database failure injection using a transaction-local setting and a test-only temporary trigger that raises after run/outbox update; never modify production migrations. Assert full rollback and retrying settlement charges once.
- [ ] Simulate failure after HTTP acknowledgement but before settlement commit; run later expired reconciliation. Assert no false delivered metric and no callback state regression. If still eligible, any transport replay uses the original identity.
- [ ] Test genuine queued exhaustion followed by `runWorkspaceCapacityMaintenance()`: aggregate review state is consistent, capacity settles without a live lease/operation, and a live operation retains charges until its deadline; terminal recovery never releases another owner's authority.
- [ ] Return committed settlement outcomes to the worker; emit exactly one accepted outcome/duration sample, with bounded labels and no raw request/body/prompt/token logging. Test rollback, stale success, cancellation, recovered progress, and exhaustion counts using metric deltas.
- [ ] Document operator queries for execution/run/outbox/reservation inconsistency; do not auto-repair historical completed→review corruption by deleting evidence or launching a new root. Record unresolved records for explicit reconciliation.
- [ ] Run focused and complete validation below, obtain independent concurrency/recovery review, and update quality evidence with actual results and skipped checks. No release claim from unit tests alone.

## Validation commands and harness

Run from `control-plane`. Existing `.github/workflows/ci.yml::validate` provisions PostgreSQL 16 and Redis 7, sets `NODE_ENV=test`, matching `DATABASE_URL`/`CONTROL_PLANE_TEST_DATABASE_URL` with database name `acornops_control_plane_test`, applies `npm run db:migrate`, then runs `npm run validate:ci`. Reuse that harness; never point destructive fixtures at a developer/shared/production database.

```bash
NODE_ENV=test node --import tsx --test --test-concurrency=1 test/workflow-dispatch-recovery-postgres.test.ts test/dispatch-capacity-postgres.test.ts test/workflow-run-approvals-postgres.test.ts test/workspace-capacity-fixes-postgres.test.ts
npm run validate
npm run validate:ci
```

Expected: all targeted assertions pass; full checks, build, contracts, and coverage succeed. Repeat the deterministic race test group 20 times in the isolated CI stores; all runs must pass. At implementation qualification, run the documented integration compose profile with pinned control-plane/engine dependencies and a dropped dispatch response; verify one logical execution, accepted callbacks, and no duplicate tool operation. Provisioning and service operations require the later implementation task's authorization.

## Rollout, rollback, and acceptance

- Publish a control-plane-only compatible image after validation/review. Existing schema and wire contracts stay unchanged; deployment release-pin work is a separate authorized action.
- Canary with response-loss, safe-drain, cancellation, and start-event probes. Observe dispatch outcomes, oldest pending/claimed age, review counts, state mismatch queries, and reservation settlement; no increase in duplicate logical executions or stuck claims.
- Old replicas can still execute the unsafe path during mixed rollout. Keep the qualification window short and require all workers upgraded before declaring protection complete; do not claim a new replica repairs an old worker's corruption.
- Rollback restores the prior image without data downgrade, but restores the defect. Pause Workflow dispatch using the existing dispatch gate before rollback if response-loss corruption recurs; preserve pending rows and inspect inconsistencies before reopening.
- Acceptance: every table row/race passes on actual Postgres; third lost response cannot overwrite terminal/progress/approval/cancellation state; current claim alone settles; rollback is atomic; no fresh identity or unauthorized cancellation appears; maintenance retains active charges and eventually clears eligible ones; metrics describe committed outcomes only.

**Estimate:** 3–5 engineer-days: 0.5–1 day fixtures/state matrix; 0.75–1.25 days atomic settlement/cancellation; 0.5–1 day same-path fencing/recovery; 1.25–1.75 days fault injection, repeated races, full validation, integration qualification, review, and docs. The state guard itself is small; most effort establishes atomic recovery and real database ordering. This reduced estimate excludes the deferred uncertainty/resume-policy redesign, infrastructure provisioning delays, and deployment rollout.

## Planning evidence — 2026-10-30

Re-read worker, engine client, callback/commit controller, aggregate, cancellation, approval uncertainty/resume, reservation settlement/maintenance, fixtures, migration fields, and CI harness. No runtime behavior has changed. Planning checks and handoff results are recorded after the document is finalized; runtime regressions and live qualification above remain execution work.

- `git diff --check`: passed for documentation changes.
- `npm run harness:check`: passed after adding the plan/index entry.
- Self-review: transition rows map to Tasks 1–3; persistence/metrics/reservation failures map to Task 4; interfaces distinguish observed reconciliation from a charged HTTP outcome.
- Full product validation, SQL upgrade checks, new regressions, and integration services were not run for this documentation-only task. Earlier review checks do not qualify the proposed implementation.

The existing `claim_owner text`, `attempt_count`, expiry, status, and error fields appear sufficient for this design. That is an inspected schema assumption, not a migration compatibility test. Any requirement for additional durable delivery generations or outcome journals must be justified with a failing crash/reclaim regression before changing the no-migration scope.
