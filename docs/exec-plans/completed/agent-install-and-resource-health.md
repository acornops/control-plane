# Agent Install and Resource Health

## Goal

Generate Helm install commands using only the structured namespace scope values,
and make normalized pod attention filtering agree with container failure states.

## Decisions

- Removed generated `config.watchNamespaces` output instead of escaping its
  comma-separated value. `namespaceScope.include/exclude` are the only generated
  namespace scope settings.
- Reused one critical container-reason set within each runtime so normalized
  indexing, findings, and console rendering classify the same pod states.
- Classified the Kubernetes `Unknown` pod phase as attention so the server-side
  filter agrees with the console's unhealthy predicate for every pod phase.
- Added no migration or backfill. The next agent snapshot replaces normalized
  resource rows with the corrected status and attention flag.

## Validation Log

- Targeted control-plane install-instruction and snapshot-listing tests: passed
  (16 tests).
- Control-plane typecheck, style, migration static checks, authorization,
  membership, run-event durability, contracts, OpenAPI, harness, and build:
  passed.
- Full control-plane validation: stopped in unrelated database-backed tests
  because `CONTROL_PLANE_TEST_DATABASE_URL` is not configured.
- Targeted management-console install-command and mapper tests: passed (8 tests).
- Full management-console unit suite: passed (752 tests).
- Management-console design check, lint, membership, contracts, harness, build,
  and route smoke checks: passed.
- Management-console visual snapshots could not launch because the configured
  `/usr/bin/google-chrome` executable is absent.
- Workspace cross-repository contract check: passed.

## Completion

- Generated commands contain `namespaceScope.include` and
  `namespaceScope.exclude` without `config.watchNamespaces`.
- Running pods with critical container reasons are indexed and rendered with the
  critical reason and remain eligible for the unhealthy-only filter.
- No product documentation changed because the structured Helm setting was
  already the documented chart interface.
