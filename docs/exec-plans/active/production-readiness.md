# Focused production readiness corrections

## Scope

Fix the confirmed AI-policy fail-open edge case and verify VM issue recovery
against incomplete telemetry, and patch compatible HTTP parser dependencies.
Preserve authentication, database history, stored settings, and unrelated
behavior. The only wire addition is optional AgentV finding-coverage metadata
mirrored in both contract manifests; the existing snapshot version remains valid. Branch:
`fix/production-readiness`. The follow-up request on 2026-10-26 authorizes
final review, publication, and an in-place demo upgrade, not production promotion.

## Checks

- [x] Add a regression for a sole-custom-model policy followed by opt-out; assert
  empty effective model lists, preserved disabled reasoning and saved default,
  unavailable model rejection, re-enable recovery, and explicit reset recovery.
- [x] Replace the deployment-ceiling fallback with fail-closed constraints while
  retaining validation that newly saved policies need an enabled default.
- [x] Assess incomplete VM telemetry with a concrete recovery regression before
  implementing the smallest correction.
- [x] Update operations guidance and run focused tests plus `npm run validate`
  against isolated PostgreSQL/Redis; rerun cross-repository contract checks.
- [x] Independently review the final diff and record exact results and limits.

## Evidence — 2026-10-26

- AI-policy regressions failed before implementation, then passed, including
  unavailable-model rejection, re-enable, explicit reset, and empty-save rejection.
  Tests live in a focused file to preserve the existing harness file-size budget.
- VM recovery regression first failed because an unavailable collector resolved
  an absent issue. Repository wiring and pure coverage tests now pass. Independent
  review caught the distinction between complete findings and trimmed inventory;
  optional per-collector coverage fixes both filesystem and service recovery while
  keeping legacy incomplete snapshots conservative.
- Compatible lock refresh: body-parser 2.4.0, proxy-addr 2.0.8, qs 6.16.1 and their
  required transitive dependencies, without upgrading Express. Public/internal
  compressed-body smoke checks pass. `npm ls` reports a valid dependency tree.
- Final `npm run validate` passed 1,340 tests, type/style, authorization, membership,
  run durability, migration-chain static, contract, OpenAPI, harness, and build
  checks using disposable PostgreSQL/Redis. Earlier no-database/sandbox attempts
  were environmental failures, not accepted evidence.
- `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL=<disposable-db> npm run migrations:check`
  passed the SQL upgrade checks in an isolated, subsequently removed schema.
- `task validate` at workspace root passed cross-repository contracts and runtime
  truth. Independent re-review found no additional actionable issues.
- `npm audit --omit=dev` now reports only Nodemailer and Zod; neither is claimed
  fixed. See the deployment readiness audit for remaining security and operational
  gates. No production database, secret store, live provider, or real VM was used.

Initial evidence logs: `/tmp/acornops-production-audit-krjHWi/`. Release validation
is recorded separately below; local test success alone is not production approval.

Release preflight, 2026-10-26: fresh `npm run db:migrate && npm run validate`
passed against unique disposable PostgreSQL 16/Redis 7 containers: 1,340 tests,
SQL migration-chain verification with the dedicated migration test URL, type/style,
authorization, contracts/OpenAPI, harness and build. Independent final review
found no new blocker. Target `.39` is an experimental demo release; Nodemailer,
Zod and target-environment production acceptance gates remain explicit.
