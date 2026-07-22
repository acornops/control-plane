# Mattermost External Integration Port Forward

## Goal

Port the control-plane side of Ryan Goh's four cumulative external-integration
pull requests (#9, #10, #11, and #13) onto the current architecture through
the shared `temp-main` integration branch. Preserve Ryan's original commits and
authorship while adapting their behavior to current Workflow V2, target,
authentication, webhook, migration, and OpenAPI contracts.

Central tracking: acornops/acornops#12.

## Constraints

- Merge, do not squash, rebase, cherry-pick, or force-push the original commits.
- Integrate waves in order. Retarget each existing PR to `temp-main`, merge the
  current integration line into its head, and resolve conflicts on that head.
- Preserve explicit `requireUser` and `requireExternalIntegrationClient`
  boundaries. Add linked external actors only to routes required by the bot and
  keep workspace, target, capability, and token-scope authorization fail-closed.
- Preserve Workflow V2 `capabilityPolicy`, prompt-resource binding, catalog
  readiness, compiled scopes, coordination/delegation, target-tool narrowing,
  OIDC admission/logout/prelinks, AgentV contracts, and PDF artifact retention.
- Fold unreleased table or column additions into
  `migrations/control-plane/001_initial_schema.sql`; do not restore obsolete
  numbered pre-release migrations.
- Preserve the current SSRF-safe webhook delivery policy. Development delivery
  to a private Mattermost bot must use exact allowed host/IP patterns, never a
  broad insecure-delivery switch.
- Regenerate public OpenAPI artifacts from source and keep mirrored contract
  manifests synchronized.
- Treat the Mattermost bot repository as a read-only contract oracle unless a
  bot-side defect is independently proven.

## Wave Scope

1. Linked external actors and bounded workspace/target read grants.
2. Workflow/session/message access plus webhook connection management.
3. Durable issue lifecycle webhook delivery and delivery status/history.
4. Write-run execution, SSE status, and approval decision support.

## Decision Log

- 2026-07-22: `temp-main` was created from control-plane `main` at `646c67c`.
- 2026-07-22: Existing PRs remain the integration vehicles so Ryan's commits
  remain reachable in normal merge history.
- 2026-07-22: Newer control-plane logic is authoritative when old and new
  implementations conflict; the Mattermost integration is adapted around it.
- 2026-07-22: The current single greenfield schema baseline is authoritative.
- 2026-07-22: Automation outbox state and webhook delivery state remain
  separate durability concerns even if they use analogous worker patterns.

## Validation Log

- Baseline: `npm run validate` passed on untouched `main` against an initialized
  isolated PostgreSQL database: 775 tests, migration checks, authorization,
  membership, run-event durability, contracts, OpenAPI, harness, and build.
- Each wave: run focused external-integration tests, authentication/authorization
  regressions, webhook tests where applicable, migration checks, contract and
  OpenAPI checks, then the complete repository validation.
- Final: exercise the Mattermost bot endpoint inventory and live linking,
  workflow, event, execution, SSE, and approval flows against the integrated
  stack.

## Completion Criteria

- PRs #9, #10, #11, and #13 are merged with merge commits into `temp-main` in
  order, and every original Ryan commit is reachable from it.
- Current architectural invariants remain covered and green.
- All bot-required public endpoints are documented and contract-tested.
- A draft `temp-main` to `main` PR is ready for manual human review and is not
  automatically merged.
