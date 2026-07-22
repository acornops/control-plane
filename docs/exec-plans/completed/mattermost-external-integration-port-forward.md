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
  V2 instead of restoring the older step/policy model. At this wave boundary,
  linked external actors were limited to active ungated read-only definitions
  with effective grants for workspace reads, session creation, read-only runs,
  and every workflow-required permission. Wave 4 deliberately expanded that
  same path to active read-write and approval-gated definitions behind the
  three-layer `create_read_write_runs` opt-in. Session messages retain the
  current typed prompt-reference, catalog-readiness, exact target-tool
  narrowing, compiled-scope, and user-owned session behavior.
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
- 2026-07-22, Wave 4: Added external write-run opt-in without restoring the
  older step/policy execution model. Active read-write or approval-gated
  Workflows require `create_read_write_runs`; active ungated read-only
  Workflows continue to require `create_read_only_runs`. Every external
  Workflow message uses current Workflow V2 typed prompt resolution and exact
  compiled scope, while its session remains pinned to the original definition
  and the current definition must still be active and authorized.
- 2026-07-22, Wave 4: Persisted exact integration link/client provenance for
  troubleshooting runs, Workflow sessions, and Workflow executions in the
  greenfield baseline. Session continuation, reports, pre-run gates, and
  runtime write approvals fail closed unless the exact originating link and
  client match. Approval requires current write capability; the exact origin
  may still reject after write revocation while workspace read access remains.
- 2026-07-22, Wave 4: Replaced legacy step-index events with durable execution,
  entry-run, approval, accepted run-event, and terminal transition records.
  Browser execution detail retains the current rich Workflow V2 response;
  linked integrations receive a deliberately sanitized workspace-readable DTO
  and replayable SSE stream. Stable external `clientRequestId` values are
  required, race-safe, and return the exact persisted run scope on retries.
- 2026-07-22, Wave 4: Kept current Workflow V2 coordination, principal,
  capability routing, target-tool narrowing, report-artifact routes, and
  greenfield migration policy. Extracted focused approval-inbox and execution
  stream metric modules to stay within repository harness budgets.
- 2026-07-23, production sweep: Made troubleshooting, automation, and Workflow
  approval decisions compare-and-set transitions. Only the winning request now
  emits decision audit, event, and metric side effects; identical retries remain
  idempotent, while conflicting or expired decisions return explicit conflicts.
- 2026-07-23, production sweep: Made external account-link completion atomic
  across token consumption, link upsert, grant replacement, and account audit.
  Link resolution now refreshes `lastAuthenticatedAt`, and PostgreSQL tests
  cover commit and rollback behavior so a partial link cannot escape.
- 2026-07-23, production sweep: Added explicit public projections for
  external-integration run reads, events, nested Workflow events, and SSE.
  Internal prompts, model/provider details, tool arguments, and unrelated
  execution data no longer cross the bot credential boundary; exact-origin
  output remains available where the bot needs it.
- 2026-07-23, production sweep: Moved initial Workflow execution/run/approval
  events into the execution transaction. Scheduler and controller publication
  now happens only for committed events, closing a durability gap between the
  persisted execution and its replayable aggregate stream.
- 2026-07-23, production sweep: Hardened webhook delivery fencing and
  observability. Terminal metrics require an accepted lease-owned completion,
  queue metrics include processing jobs and refresh while disabled, leases
  cover the configured same-origin batch, and secret rotation plus audit are a
  single transaction using only a delivery URL hash in metadata.
- 2026-07-23, production sweep: Reconciled stale report paths, public OpenAPI
  descriptions, bot payload guidance, privacy guarantees, and per-replica
  worker documentation. The bot oracle rule permitted one independently proven
  bot defect to be fixed in its own repository: strict Workflow message bodies
  accept only `content` and `clientRequestId`; launch inputs, grants, and target
  bindings stay fixed at session creation.
- 2026-07-23, production sweep: Replaced the OIDC logout test's module-load-time
  60-second session with a fresh fixture per case. The enlarged suite had made
  that otherwise unrelated test expire before execution; production logout
  behavior was unchanged.
- 2026-07-23, production sweep: Cleared the production dependency audit by
  updating the resolved `body-parser` and `ws` releases and moving Nodemailer
  to its patched 9.x release. The mailer uses the same bounded, application-
  generated message shape; the complete validation covers type and build
  compatibility after the major dependency update.
- 2026-07-23, production sweep: Kept every existing repository module within
  its harness budget by extracting approval compare-and-set queries, initial
  Workflow stream-event persistence, and link-completion audit construction
  into focused helpers. This preserves the new transactional behavior without
  concentrating unrelated responsibilities in the aggregate repositories.

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
- Wave 4 control plane: the consolidated schema initialized successfully in a
  fresh isolated PostgreSQL database and passed SQL introspection. Focused
  external Workflow, approval, schedule-inbox, authorization, metrics, and
  report-isolation tests passed, including idempotent exact-scope replay and
  preservation of the richer browser execution response. The full suite,
  authorization, membership, run-event durability, contracts, public/admin
  OpenAPI coverage, harness, and production build passed before integration.
- Production sweep: the current greenfield schema applied to a freshly created
  isolated PostgreSQL database, and static plus SQL introspection checks passed.
  Focused approval, link-transaction, scheduler, and Workflow suites passed all
  37 tests after the repository helper extraction. Final `npm run validate`
  passed all 834 tests across 163 suites, TypeScript, style, authorization,
  membership, run-event durability, contracts, public OpenAPI (158 paths / 169
  schemas), admin OpenAPI (24 paths / 24 schemas), harness, and the production
  build. `npm audit --audit-level=high` reported zero vulnerabilities.
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
