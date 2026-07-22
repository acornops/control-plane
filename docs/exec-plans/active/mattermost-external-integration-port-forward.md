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
  to a private Mattermost bot must use an allowed DNS hostname pattern, never a
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
- 2026-07-22, Wave 1: Kept current explicit `requireUser` and
  `requireExternalIntegrationClient` middleware exports. Linked external actors
  are enabled only on bot-required read/session routes; agent, workflow,
  account, MCP credential, and other user-management routes retain the newer
  user-only boundary.
- 2026-07-22, Wave 1: Folded the external-integration workspace grant table,
  indexes, and foreign keys into the current greenfield schema rather than
  restoring the older branch's numbered migration sequence.
- 2026-07-22, Wave 1: Kept current OIDC credential narrowing, workspace owner
  capability resolution, and inline target-chat OpenAPI semantics. Extracted
  the target-chat path declarations into a focused helper only to satisfy the
  current module-size budget; external actor security remains consistent with
  the mounted routes.
- 2026-07-22, Wave 1: Split external-integration normalized-snapshot coverage
  into a focused test suite to preserve the repository harness budget without
  weakening the original normalized-row regressions.
- 2026-07-22, Wave 2: Ported external workflow execution onto current Workflow
  V2 instead of restoring the older step/policy model. Linked external actors
  can list, inspect, create sessions for, and message only active read-only
  definitions with no approval requirements and with effective grants for
  workspace reads, session creation, read-only runs, and every workflow-required
  permission. Session messages retain the current typed prompt-reference,
  catalog-readiness, exact target-tool narrowing, compiled-scope, and
  user-owned session behavior.
- 2026-07-22, Wave 2: Kept webhook route connection as a linked-external-only
  boundary. Connections match only the linked AcornOps user's subscriptions at
  the exact canonical HTTPS delivery URL and only while that user's live role
  can manage webhooks. Connect rotates signing secrets transactionally and
  returns each new secret once; status never returns secret material.
- 2026-07-22, Wave 2: Removed the older development HTTP-delivery bypass from
  the port. Private Mattermost destinations must remain HTTPS, use DNS rather
  than IP literals, and be explicitly permitted by
  `WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON`; hard-blocked local, link-local,
  metadata, and reserved destinations remain blocked even when allowlisted.
- 2026-07-22, Wave 2: Folded external webhook route connection state and its
  indexes/foreign key into the greenfield schema. Kept route metrics in a
  focused module to preserve the current repository file-size harness.
- 2026-07-22, Wave 2: Normalized webhook subscription and delivery-history
  list responses to the current paged `{ items }` contract. Corrected the
  generated schema to describe the controller's actual subscription name,
  one-time secret, and history metadata rather than stale legacy field names.
- 2026-07-22, Wave 3: Ported delivery to a Postgres outbox and leased
  per-subscription jobs while retaining the current SSRF-safe HTTPS policy and
  greenfield schema. Worker completion is fenced by lease owner so a stale
  replica cannot overwrite a reclaimed job. Delivery metrics live in a focused
  current-architecture module, and retry transitions are not misreported as
  terminal outcomes.
- 2026-07-22, Wave 3: Issue created, reopened, and resolved events are enqueued
  in the same snapshot transaction as their lifecycle changes. Recovering
  issues pause current-lifecycle alerts; newer lifecycle versions supersede
  stale jobs. Event payloads match the Mattermost bot's rich-alert fields and
  remain bounded and deduplicated.

## Validation Log

- Baseline: `npm run validate` passed on untouched `main` against an initialized
  isolated PostgreSQL database: 775 tests, migration checks, authorization,
  membership, run-event durability, contracts, OpenAPI, harness, and build.
- Wave 1 control plane: the consolidated schema initialized successfully in a
  fresh isolated PostgreSQL database. `npm run validate` passed with 798 tests
  across 157 suites, plus style, migration, authorization, membership,
  run-event durability, contracts, public/admin OpenAPI, harness, and build.
  Focused external-integration authentication, grant, target, VM, assistant,
  and normalized-snapshot tests also passed.
- Wave 2 control plane: the consolidated schema initialized successfully in a
  fresh isolated PostgreSQL database. Focused workflow, webhook-route,
  webhook-contract, SSRF-policy, and configuration tests passed. `npm run
  validate` then passed 811 tests across 159 suites, SQL/static migration
  checks, authorization, membership, run-event durability, contracts,
  public/admin OpenAPI coverage, repository harness, and the production build.
- Wave 3 control plane: the durable outbox schema initialized successfully in a
  fresh isolated PostgreSQL database, and an end-to-end SQL exercise verified
  enqueue, lease claim, fenced completion, delivery history, and terminal
  cleanup. Focused worker, stale-lease, lifecycle, metrics, contract, and
  configuration tests passed. `npm run validate` then passed 818 tests across
  161 suites, SQL/static migration checks, authorization, membership,
  run-event durability, contracts, public/admin OpenAPI coverage, repository
  harness, and the production build.
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
