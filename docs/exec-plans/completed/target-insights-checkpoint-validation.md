# Target Insights checkpoint validation

Status: completed

## Goal

Make Target Insights learning outcomes trustworthy without making checkpoints
slower or noisier. A deliberate model no-op must be distinguishable from invalid
JSON, an invalid patch, and a provider failure. The management console must show
the safe diagnostic outcome already carried by workspace audit metadata.

## Scope

- `control-plane`: strict checkpoint response parsing, semantic validation,
  audit metadata, metrics, focused tests, and product documentation.
- `management-console`: backward-compatible audit metadata presentation and
  focused component/view-model tests.
- No database migration and no new public route.
- No transcript, generated insight body, raw model response, credential, or
  other sensitive content in logs, metrics, or audit metadata.

## Decisions

- Keep the existing checkpoint job statuses (`applied`, `noop`, `failed`,
  `skipped`) to avoid a schema migration.
- Treat `noop` as valid only when it is explicit, includes a bounded safe reason
  code, and is the only proposed patch.
- Treat malformed JSON, schema violations, and references to unknown entries as
  terminal invalid responses for the current session activity. New activity can
  schedule a fresh checkpoint.
- Keep transient provider failures retryable through the existing worker path,
  but record a safe failure audit event.
- Preserve the generic workspace-audit response contract. New metadata fields
  are additive and optional so older events and mixed-version rollouts remain
  readable.
- Use a deterministic fake LLM response in automated tests. Exercise the real
  checkpoint orchestration and persistence path where the isolated PostgreSQL
  test environment is available; do not wait for the configured idle interval.

## Risks

- Overly strict validation could reject useful but slightly malformed model
  output. Mitigate with an explicit schema in the prompt and precise validation
  reasons.
- Audit details could expose operational content. Store only bounded enums,
  provider/model identifiers already selected by the workspace, and numeric
  counts.
- The management-console worktree contains unrelated navigation edits. Limit
  console changes to the Insights activity surface, its tests, and narrow locale
  additions.

## Coordination

- Intended shared branch slug: `fix/target-insights-checkpoint-validation`.
- Current worktrees are on different pre-existing branches and include unrelated
  management-console changes, so this task will not switch branches or move user
  work.
- Merge order: control-plane first, then management-console. The console remains
  compatible with old events because all new metadata is optional.

## Validation

- Focused control-plane checkpoint parser, worker, persistence, audit, and metrics
  tests.
- Focused management-console activity presentation tests.
- Control-plane typecheck, contracts, harness, and validation entrypoint.
- Management-console control-plane-mode lint, tests, contracts, route smoke, and
  validation entrypoint.
- Workspace platform contract checks when both repositories are green.

## Progress

- [x] Reproduced the demo outcome and correlated it with the source session.
- [x] Confirmed checkpoint scheduling and configuration work as designed.
- [x] Implement strict response and semantic validation.
- [x] Record distinct safe audit and metric outcomes.
- [x] Improve activity diagnostics.
- [x] Add fast hermetic vertical coverage.
- [x] Complete validation and diff review.

## Progress log

- 2026-07-25: Added strict discriminated patch validation, explicit terminal outcome audits, and safe additive metadata.
- 2026-07-25: Updated the existing activity ledger with outcome, reason, model, count details, and source-session links.
- 2026-07-25: The deterministic-provider vertical test passed against a freshly migrated isolated PostgreSQL database in about 0.5 seconds of test time; the temporary database was removed afterward.
- 2026-07-25: Focused control-plane tests, typecheck, style, build, contracts, migrations static checks, and harness passed. The full validation entrypoint was invoked but could not complete because the local shell has no `CONTROL_PLANE_TEST_DATABASE_URL`; the unrelated checked-in public OpenAPI artifact is also stale.
- 2026-07-25: Management-console lint, design-system static checks, 639 unit tests, contracts, harness, build, and route smoke passed. Its full validation entrypoint reached Playwright and failed because `/usr/bin/google-chrome` is not installed in this environment.
- 2026-07-25: Production-readiness cleanup consolidated repeated terminal-outcome handling, removing 50 runtime lines. Review also aligned checkpoint tag and observation limits with the existing entry contract, suppressed misleading zero-change UI copy, added stale-lease coverage, and re-ran the isolated PostgreSQL vertical test successfully.
