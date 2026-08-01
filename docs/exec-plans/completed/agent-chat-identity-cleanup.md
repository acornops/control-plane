# Agent chat identity cleanup

Status: completed 2026-08-01

## Goal

Make direct Agent conversations bind only to an Agent identity. Each new run
resolves the current Agent and persists an immutable snapshot.

## Outcome

- Simplified direct Agent-chat persistence, public APIs, dispatch, bootstrap
  tokens, audit metadata, contracts, generated OpenAPI, and tests to use IDs
  plus immutable run snapshots.
- Added an explicit neutral Agent-chat scope keyed by workspace and Agent ID.
- Kept connector release metadata separate and retained the transactional
  stale-snapshot guard.
- Corrected direct-run capability compilation so current tools and skills are
  frozen into each new run snapshot.

## Validation

- Canonical control-plane validation passed: type, style, 1,075 tests,
  greenfield migrations, authorization, membership, run-event durability,
  contracts, public/admin OpenAPI, harness, and build.
