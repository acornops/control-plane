# Agent heartbeat freshness implementation plan

Implementation and local qualification completed 2026-11-02 on
`feat/windows-vm-support`. Merge, deployment and Windows qualification remain
separate. Exact committed revisions and hosted results are recorded in the
[backend draft PR](https://github.com/acornops/control-plane/pull/33) and
[console draft PR](https://github.com/acornops/management-console/pull/35) after push.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute inline and track steps with checkboxes.

**Goal:** Expire stale connection reporting for AgentV/AgentK while preserving Linux runtime and shared ownership behavior.

**Architecture:** Add an observed connection field to backend reads using existing registration timestamps. Fence heartbeat recording by connection identity. Consume the field with bounded cache aging in the console; keep persistent status and execution authority separate.

**Tech Stack:** TypeScript, PostgreSQL 16, Redis 7, React, node:test, Vitest and Playwright.

**Spec:** [Agent heartbeat freshness](../../design-docs/agent-heartbeat-freshness.md).

## Global Constraints

- Existing `feat/windows-vm-support` worktrees only; preserve unrelated main-checkout changes.
- No agent protocol, OS adapter, installer, schema migration, ownership-worker, permission or dispatch change.
- Additive observation; grace 120 seconds, configurable 60–600; existing stored status/filter semantics preserved.
- No merge, release, deployment, activation or production messages.
- User approved execution of the assessed approach; continue without redundant approval prompts.

## Review Focus

- A delayed old heartbeat or failed handshake cannot refresh a replacement's evidence.
- A healthy-but-degraded target remains reachable; stale evidence never erases its stored health.
- Empty/invalid/future timestamps and mixed-version missing fields do not become fabricated freshness or onboarding.
- Cached pages and counts expire even when fetches fail; client/server clock differences do not extend validity.
- Linux, Windows and Kubernetes share freshness but retain existing authorization, routing and lifecycle guarantees.

### Task 1: Record and project shared heartbeat freshness

**Files:** Create `src/services/agent-connection-freshness.ts`, focused unit and real-store tests. Modify `src/agent/ws-server.ts`, `handshake.ts`, `vm-connection-lifecycle.ts`, `src/store/repository-target-agent-registrations.ts`, `repository-vm-connections.ts`, target/VM/cluster/admin read projections/mappers, `src/config.ts`, shared domain types and relevant OpenAPI/MCP schemas.

**Interfaces:** `TargetConnectionObservation = { state: 'connected'|'disconnected'|'unknown'; lastHeartbeatAt: string|null; observedAt: string; expiresAt: string|null; hasConnectionEvidence: boolean }`. Pure `observeAgentConnection(status, connectionId, heartbeatAt, observedAt, graceSeconds)` returns that observation. SQL heartbeat recording consumes target ID, connection ID, server receipt time and accepted key version; updates only the matching registration and keeps timestamps monotonic.

- [x] Add failing behavioral tests for the observation states/boundaries and actual PostgreSQL exact-ID/monotonic writes. Expected RED before source implementation.
- [x] Implement the projection and minimal receipt guard; initialize heartbeat evidence with accepted identity instead of pre-publication handshake stamping. Expected targeted GREEN with existing connection tests retained.
- [x] Expose additive observations through target/VM/cluster/admin reads and MCP connection output; retain stored status, health and query filters. Test actual read paths, including stale and missing records.
- [x] Run targeted suites, typecheck and full `npm run validate` against isolated migrated PostgreSQL/Redis. All pass; scoped source and this record are committed together after diff inspection.

### Task 2: Report and age connection observations in the console

**Files:** Create one shared connection-observation helper and tests; modify target/VM/cluster API types/mapping, shared target descriptor/telemetry helpers, VM and cluster status/count/filter presentation and existing refresh hooks. Add targeted component/browser checks.

**Interfaces:** Consume Task 1's optional `connection`. Record local receipt time only at the API boundary; derive validity from server `expiresAt - observedAt`. Preserve the timestamp in caches. Missing legacy fields retain old mappings; invalid new fields yield unknown. Use one helper for labels, counts and filters.

- [x] Write failures for exact expiry, clock skew, cached API failure, offline/degraded/never-connected input and legacy payload compatibility. Expected RED.
- [x] Implement shared parsing/aging and wire current connection-reporting surfaces without changing command/permission policy. Expected targeted GREEN.
- [x] Exercise list/detail/filter/count agreement and stale caches during failed refresh with affected browser fixtures. Expected PASS.
- [x] Run control-plane-mode `npm run validate` plus the affected Playwright coverage. All pass; commit focused console changes.

### Task 3: Coordinate documentation, integration and final review

**Files:** Update backend/console contract and operations/development records/indexes; regenerate public API reference in sibling docs-website and document connectivity semantics. Update existing ignored workspace change-set record.

- [x] Run producer/consumer contract checks, public OpenAPI export parity and parent `task validate`. Expected PASS.
- [x] Run required isolated integration profile and real-store recovery/reconnect checks; preserve all unrelated running resources. Expected PASS with exact boundaries recorded.
- [x] Run docs `npm run validate` and `npm run links`; expected PASS.
- [x] Obtain one fresh independent review of this phase's complete diff; resolve important findings through reproduced failures and full green validation.
- [x] Prepare existing feature-branch/draft-PR handoff and retain the local validation record below. Post-commit push, exact-head hosted checks and scratch archival are recorded in the linked PRs and local evidence archive; this record makes no advance claim about those results.

## Validation evidence

All final source checks below ran after both review fixes; no runtime changes
followed them. Logs, probe source and the execution ledger are retained in the
local archive `/private/tmp/acornops-heartbeat-validation-20261102` at handoff.

| Command / check | Result and boundary |
| --- | --- |
| Control plane `npm run validate` with isolated migrated PostgreSQL 16/Redis 7 test URLs | 1,769 tests, 259 suites, zero failures/skips; type/style, migrations/SQL upgrades, authorization, membership, durable events, contracts, OpenAPI, harness and build pass. |
| Focused backend `node --import tsx --test --test-concurrency=1` on the five new heartbeat suites plus lifecycle, VM guard, real-store ownership and MCP suites | 86 tests pass, zero skips. |
| Console `VITE_APP_DATA_MODE=control-plane npm run validate` | 1,290 tests across 238 files; type/contracts/harness/build/bundle/route gates pass. |
| Console `FIXTURE_APP_PORT=4193 ./node_modules/.bin/playwright test --config=playwright.fixtures.config.ts tests/fixtures/agent-heartbeat-freshness.spec.ts tests/fixtures/target-catalog-card-clarity.spec.ts tests/fixtures/agentv-onboarding.spec.ts tests/fixtures/windows-collection-health.spec.ts --workers=1` | 11 tests pass: expiry through failed refresh/navigation, lists/details/counts/filters, onboarding and Windows collection health. Synthetic host/API fixtures; no native Windows qualification. |
| Docs `npm run validate` and `npm run links` | Pass; no broken links. Generated public API 176 paths / 194 schemas, admin 37 paths / 35 schemas. |
| Parent `task validate` | All workspace/contract/runtime-truth gates and four subprocess tests pass. |
| Actual backend helper → actual console parser probe | Invalid/future/missing evidence and onboarding distinctions pass. |

The isolated integration command used `docker compose --env-file /dev/null
-p acornops-heartbeat-integration-20261102 -f docker-compose.yml
-f docker-compose.override.yml -f .superpowers/sdd/agent-heartbeat-freshness/integration.override.yml
--profile integration up -d --build`. Control plane, execution engine and gateway
readiness returned HTTP 200. A real WebSocket/real PostgreSQL probe exercised
AgentK and Linux AgentV handshake, heartbeat silence/expiry, recovery, disconnect
and reconnect, preserving degraded health and metadata. It passed with distributed
routing both disabled and enabled. A first attempt during container recreation
hit a readiness race; rerunning after an asserted ready response passed. No
production configuration or native agent process was involved.

Full console browser matrices are delegated to existing hosted CI; local coverage
is the affected fixture set above per the console handoff policy. Real reboot,
power loss, native Windows collection and deployment soak were not run because
this change qualifies shared reporting, not Windows rollout.

## Review and decisions

One independent whole-change review found zero critical, two important and zero
minor findings. Both important findings were reproduced failing before fixes:

- An AgentK attempt closed during its final identity write could leave fresh
  evidence. The fix invalidates only that exact connection's heartbeat; a
  concurrent replacement and persisted health/identity remain intact.
- Normalized invalid/future heartbeat evidence could look like initial setup.
  `hasConnectionEvidence` preserves the distinction through backend and console.

Both regression tests and the final full suites pass. No deferred minor findings.
The initial browser label/duplicate-selector failures were corrected test
assumptions; they are not claimed as proof of an isolated timer defect.

Rulings made during execution:

- Keep persisted status and existing API filters; add separate freshness. Older
  consumers retain their historical status semantics.
- Use 120 seconds by default, configurable 60–600. This bounds detection latency
  while tolerating usual heartbeat delays; connection reporting is not authority.
- Execute the approved design on existing feature branches without repeated
  approval prompts; review remains before any merge or activation.
- Begin console work after focused backend contract tests pass, while full
  validation runs; final validation covers both producer and consumer.
- Increase the combined generated OpenAPI line budget from 34200 to 34300 for the
  additive shared schema, preserving audience/schema coverage checks.
- Review the frozen working-tree phase diff before commit; qualify fixes again
  with focused and full checks rather than dispatching another reviewer.
- Add one evidence Boolean to distinguish rejected timestamps from absence;
  legacy payloads remain accepted.
- Exclude durable ownership/status/event repair; reporting expiry does not
  synthesize disconnect events or reconcile persisted lifecycle rows.
- Exclude deployment and native Windows qualification; existing collector and
  reboot questions remain separate.
- Retain already completed fresh final-suite logs instead of rerunning the same
  suites only to populate a bookkeeping wrapper. Documentation-only closeout gets
  its own contract/harness/diff checks. Hosted results are recorded after commit.

Rollback: revert the additive reporting change and its narrow timestamp guard;
no agent downgrade or database rollback is required. Broader outage-status repair
and Windows qualification remain open.
