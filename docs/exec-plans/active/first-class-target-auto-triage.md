# First-Class Target Auto-Triage

## Goal

Add durable, target-native automatic investigations for Kubernetes clusters and
virtual machines. A qualifying issue creates exactly one existing assistant
session and run per issue lifecycle, while target safety, approval, audit,
retention, workflow, and execution-engine behavior remain authoritative.

## Constraints

- Keep workflow issue triggers unchanged and independent.
- Reuse target sessions, runs, tools, approvals, cancellation, audit, and
  retention instead of adding a parallel remediation domain.
- Default the feature to disabled with warning severity and target-following
  write behavior.
- Never make automatic behavior less restrictive than the target agent or
  target confirmation policy.
- Preserve creator-only behavior for manual sessions.
- Treat all new public response fields as additive and optional.
- Bound persisted errors, metrics labels, issue evidence, and prompt additions.

## Contract and Persistence Decisions

- Store one revisioned setting record per target and one durable job per
  `(issue_id, lifecycle_version)`.
- Add automatic origin and linked issue metadata to sessions, actual user
  authorship to messages, and a truthful `system` run actor.
- Resolve and pin write behavior when the investigation starts.
- Keep automatic investigation activity separate from workflow activity.
- Use the existing target execution dispatch and cancellation paths.
- Keep one session API and target chat route, while allowing the console to
  separate manual Chats from automatic Investigations by session origin.
- Keep the supplementary unseen badge as per-user, per-target browser UI state
  derived from existing session timestamps; do not add notification, API, or
  queue-management objects.

## Runtime Decisions

- Enqueue only for newly eligible issue lifecycle events, explicit bulk start,
  or explicit retry.
- Run the target auto-triage worker on its own timer and error boundary. It does
  not depend on the Automation runtime mode, Workflow scheduler, event outbox,
  or Workflow definitions being present or healthy.
- Claim jobs with database leases and limit nonterminal automatic runs to two
  per target.
- Retry readiness blocks with capped backoff and unexpected failures a bounded
  number of times.
- Reuse linked session/run state after lease recovery; never create a
  replacement session for the lifecycle.
- Stop queued or running automatic work when the linked issue resolves.
- If a queued lifecycle was skipped because auto-triage was disabled before it
  started, re-enabling exposes it as an eligible current issue; the explicit
  start action requeues the same durable job instead of creating a duplicate.

## Validation Log

- 2026-07-29: the queue-visibility polish added a compact per-target
  active/waiting summary, oldest-waiting age, and low-cardinality global backlog
  gauges. Snapshot queries are restricted to nonterminal jobs so retained
  history does not increase the worker's one-second metrics cost. The complete
  validation suite passed with 1,025 tests plus every static, migration,
  authorization, contract, OpenAPI, harness, and build gate.
- 2026-07-29: `npm run validate` passed against the isolated PostgreSQL
  database, including 1,022 tests, migration SQL checks, authorization checks,
  contracts, OpenAPI coverage, harness checks, and the production build.
- 2026-07-29: the independence audit separated auto-triage from the Workflow
  scheduler timer and error boundary, added import/permission regression
  guards, and verified that auto-triage requires target/run permissions rather
  than `manage_workflows`.
- 2026-07-29: PostgreSQL regression coverage verifies that a lifecycle skipped
  on disable becomes explicitly startable after re-enable without creating a
  second job or automatic session.
- 2026-07-29: the cleanup audit added durable product, operations, and security
  documentation; removed stale AgentK `patch_workload` and `patch_configmap`
  contract references; and kept OpenAPI size-budget changes to the minimum
  required headroom.
- 2026-07-29: focused PostgreSQL coverage passed for safe defaults, optimistic
  revision conflicts, one-job-per-lifecycle idempotency, per-target claim
  limits, and retry generation.
- 2026-07-29: AgentK and AgentV executor concurrency regressions passed
  (`26` and `4` tests respectively).
- 2026-07-29: workspace platform harness, contract, runtime-truth, and
  conventional-commit checks passed.
- 2026-07-29: the production hardening audit added exponential readiness
  backoff, lease-fenced atomic run/job dispatch transitions, terminal-error
  redaction, caller-truthful retry permissions, prompt-injection boundaries,
  controller authorization regressions, and PostgreSQL replica-recovery
  coverage.
- 2026-07-29: a final replica-race review extended lease fencing to
  pre-dispatch skips and issue-resolution cancellation, and PostgreSQL coverage
  verified that issue deletion removes the durable job while retaining the
  ordinary chat with its issue link cleared.
- 2026-07-29: the final production audit made current-issue bulk queueing
  revision-locked and atomic, added expected-status run row locking plus
  terminal reconciliation for execution-engine races, bounded every persisted
  job error code, restored transition audits during crash recovery, escaped the
  administrator prompt delimiter, locked the enabled settings revision at
  session creation, and cleaned up issue-action and deep-link fallback behavior
  in the console.
- 2026-07-29: the final cleanup split lease operations, run transitions, retry
  timing, and the settings-revision race into focused modules under all harness
  budgets, and added a per-process guard against overlapping worker ticks. All
  9 isolated PostgreSQL auto-triage persistence and concurrency regressions
  passed after the extraction.
- 2026-07-29: the release gate added explicit baseline assertions for every
  auto-triage table, pinned session/run field, foreign key, and operational
  index; the baseline passed fresh PostgreSQL introspection. It also aligned
  normalized Unicode instruction limits across the API and UI contract, and
  moved non-degradable MCP bootstrap failures into pre-chat readiness.

## Completion Criteria

- Settings, enqueueing, worker recovery, shared automatic sessions, issue
  activity, approval context, OpenAPI, contract manifests, docs, and focused
  tests are implemented.
- Control-plane validation and the cross-repository workspace checks pass.

Status: complete; keep active until the coordinated change lands, then move
this plan to `completed/`.
