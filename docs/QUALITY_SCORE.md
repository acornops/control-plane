# Control Plane Quality Score

Assessment date: July 26, 2026.

| Area | Score | Evidence | Main Gap |
| --- | --- | --- | --- |
| Public and internal contracts | 4/5 | Mirrored contract docs, workflow-activity schemas, manifests, repo checks, and OpenAPI coverage | No consumer-driven end-to-end contract tests across repos |
| Auth and identity flows | 4/5 | OIDC/session docs, password policy/change tests, JWKS exposure, token boundary docs | Broaden auth regression coverage for full OIDC callback/linking scenarios |
| Run orchestration | 4/5 | Bootstrap/context/events/commit paths, immutable origin capture, trigger pointers, and activity queries are documented and checked | More cross-service failure-mode coverage is still needed |
| Workflow activity reads | 4/5 | Stable pagination, workspace isolation, safe provenance, and focused Postgres tests | The console currently uses bounded polling rather than an event-driven workspace feed |
| Agent bridge | 3/5 | Handshake/snapshot/tool bridge documented and checked | No replay harness for large or degraded snapshot conditions |
| Harness knowledge base | 4/5 | AGENTS entry point, indexed docs tree, plan directories, quality/security/reliability docs | Freshness still depends on developers updating docs as features evolve |

Re-score this file when a major architectural or operational change lands.

## Workflow queue investigation — October 31, 2026

Default dispatch and maintenance-pause regressions cover removal of the obsolete
automation rollout mode. The reproduced capacity-maintenance defect that left
summaries queued after run expiry now has an [atomic repair and bounded historical
reconciliation](exec-plans/active/2026-10-31-capacity-maintenance-status.md), with
PostgreSQL rollback, start/renewal races, suspension, and retry regressions.
Existing scores are unchanged.

## Hosted-readiness evidence — September 6, 2026

The full 1,284-test suite and SQL upgrade chain pass, with independent reviews of
policy, capacity, lifecycle, rollout and native-tool authority fixes. A two-control-plane/two-engine
PostgreSQL/Redis probe verifies concurrent admission, independent pool execution
and settlement using deterministic operation bodies. Live provider and external
MCP reliability remain separate measurement needs; existing scores are unchanged.

## Release audit — October 26, 2026

Focused model-policy and VM-recovery corrections pass 1,340 tests, SQL upgrade
checks, contracts, harness, and build. Compatible HTTP parser security patches
are included. The follow-up [runtime validation qualification](exec-plans/completed/runtime-validation-security.md)
adopts patched Zod 4 and Nodemailer, with 1,354 passing tests, default/optionality
and real loopback SMTP regressions, and no independent review findings. This is
not a production sign-off: unconstrained collection
budgets remain open in the [debt tracker](exec-plans/tech-debt-tracker.md), and the
actual production database ancestry and restore rehearsal have not been verified.
Existing scores are unchanged.

## Scoped hardening evidence — October 31, 2026

[Validation and retention checks](exec-plans/completed/2026-10-31-validation-retention.md)
cover webhook bounds, PostgreSQL cleanup races, real-process schema deadlines,
cancellation and unknown-write outcomes. Fresh review findings have regression
coverage. Existing scores and broader integration coverage gaps remain unchanged.

VM lifecycle follow-up (2026-11-01): ordinary disconnect identity fencing does not
provide durable outage recovery. The [shared repair design](design-docs/vm-connection-status-repair.md)
records the Redis/PostgreSQL observation gap and the reviewed protocol gate. No
periodic writer or shared lifecycle change is included in Windows hardening.

Heartbeat reporting follow-up (2026-11-02): additive connection observations expire
after the configured grace without rewriting stored status. Exact-ID, monotonic
heartbeat writes and Linux/Windows/Kubernetes read paths have regression coverage.
This addresses stale connection display; durable status repair and disconnect
event recovery remain separate gaps.
