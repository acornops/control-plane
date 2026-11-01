# Shared VM status repair implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Track steps with checkboxes. This plan is at a protocol design gate; no shared runtime implementation is authorized by this document alone.

**Goal:** Repair orphaned persisted VM status after recovery/restart without stale ownership observations clearing a live replacement.

**Architecture:** Reuse persisted VM identity as durable repair work. Establish the authoritative ownership/generation protocol before adding a bounded VM-only worker. Preserve the ordinary lifecycle and all OS adapters until that gate passes.

**Tech stack:** TypeScript, PostgreSQL, Redis/ioredis, existing service lifecycle and node:test integration fixtures.

**Spec:** [VM connection status repair](../../design-docs/vm-connection-status-repair.md).

## Global constraints

- Separate shared-backend work; Linux and Windows have identical identity safety requirements. Existing Kubernetes behavior stays unchanged.
- No merge, release, activation, migration or shared runtime change as part of the Windows hardening pass.
- A missing owner observed earlier is not current authorization. Errors, timeouts, malformed values and disabled coordination never mean absence.
- No unfenced late mutations after cancellation; no Promise-race-only timeout for mutating work.
- No new repair queue: the persisted row is durable work. Do not overwrite metadata, settings, permissions, enrollment or administrative status.

## Review focus

- Missing Redis response delayed across replacement claim: stale A work cannot authorize clearing live B.
- Process dies or SQL/Redis response is lost: recovery remains idempotent and uncertain commits are not reported as rollback.
- Healthy rows fill early pages: later orphans must eventually be examined without unbounded scans.
- Drain occurs during observation/lock wait: all work terminates within a demonstrated bound, with no later write.
- Old and new backend replicas coexist: rollout/rollback must not bypass generation fencing.

### Task 1: Prove the protocol boundary before source changes

**Files:** `test/agent-vm-connection-postgres.test.ts`; a focused real-Redis companion `test/vm-connection-repair-ownership.test.ts`; this plan/spec; `docs/contracts/README.md` only after the guarantee is selected.

**Interfaces:** Existing `publishVirtualMachineConnection` and `vmConnections.transition`; actual Redis claim/get/renew operations. No new public/runtime interface at this gate.

- [x] Add a deterministic real-store race: lock persisted A, pause a missing GET reply, claim B, release the reply, then allow B's SQL transition. Record the permitted current intermediate status and final identity without calling it a new regression.
- [x] Cover B committed before candidate locking; assert exact-ID cleanup cannot clear B and cannot alter settings/admin status.
- [ ] Define whether a replacement becomes live at Redis claim or at post-commit publication, then specify one authoritative ownership protocol with exact claim/renew/dispatch/heartbeat/close/drain ordering, lease expiry authority, failure/cancellation semantics, and mixed-version rollout/rollback. Enumerate every ownership writer/consumer before selecting SQL/schema changes.
- [ ] Independently review that protocol against the above races. Do not proceed with a periodic writer if the only proof is repeated Redis reads or an expiring worker lock.

### Task 2: Make observation and transaction lifetime bounded

**Candidate files:** `src/services/control-plane-coordination/agent-owner.ts`, its facade, a repair-specific transaction helper beside `src/store/repository-vm-connections.ts`, focused integration tests. Exact production interfaces must be fixed by the reviewed Task 1 protocol before editing.

- [ ] Characterize real client behavior for null/present/invalid/disabled/error/timeout and queued reads; assert only authoritative absence can authorize repair.
- [ ] Implement protocol-compatible observation isolation, finite connection/transaction lifetime, and continuation invalidation. Preserve existing mutating Redis client semantics and normal transition defaults.
- [ ] Kill/cancel during lock wait, observation and COMMIT; assert no new command/event after cancellation, finite client cleanup, and honest uncertainty for an already-issued COMMIT (cancellation cannot prove rollback). Run real stores, typecheck and required validation; review and commit.

### Task 3: Add the bounded VM repair service

**Candidate files:** `src/store/repository-vm-connections.ts`, `src/agent/vm-connection-lifecycle.ts`, new `src/services/vm-connection-reconciliation.ts`, `src/server.ts`, focused service/real-store tests. Use the reviewed Task 1 protocol, not an unqualified absence predicate.

- [ ] Add behavioral failures for orphan recovery without reconnect, restart with only durable rows, two workers, replacement, uncertainty, admin/settings races and cleanup. Keep Linux/Windows cases together.
- [ ] Implement fair keyset candidate scanning, exact identity/status rechecks, a narrow local connection/pending-attempt predicate, existing VM event semantics, single-flight scheduling and tracked shutdown. Select measured numeric bounds in the task brief before code; account for rows inspected and started transaction completion separately from admission budget.
- [ ] Test empty eligible pages, healthy-prefix starvation, cursor wrap, exhausted budgets and dependency outage. Aggregate bounded outcome counts; never log owner content or one warning per target.
- [ ] Run existing Linux/Windows handshake/disconnect/draining/telemetry/settings and unchanged Kubernetes suites plus real-store recovery tests, contracts/harness/typecheck/full validate. Independently review before commit.

### Task 4: Qualify rollout and document the remaining guarantees

**Files:** `docs/contracts/README.md`, mirrored AgentV VM lifecycle contract, `docs/OPERATIONS.md`, `docs/exec-plans/tech-debt-tracker.md`, this plan.

- [ ] Exercise the reviewed mixed-version sequence, dependency loss and process restart on deployed backend replicas. Verify repair after TTL plus a fair sweep; do not advertise an outage SLA from the tick interval.
- [ ] Document disabled-coordination topology, uncertain outcomes, aggregate diagnostics and existing post-commit notification loss window.
- [ ] Review source and evidence independently; enable the service only through the reviewed rollout contract. Windows hardening remains separate.

## Current disposition

Design assessment completed on 2026-11-01. The narrow sweep cannot satisfy the
strong stale-observation guarantee across Redis/PostgreSQL. Task 1 is the concrete
remaining dependency; Tasks 2–4 are conditional work packages, not executable
production specifications. Expand their exact signatures/bounds only after Task 1
settles authority and rollout. No shared source, schema or runtime policy changed.
