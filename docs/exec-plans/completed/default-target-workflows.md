# Default target Workflows

## Goal

Replace the generic Target diagnostics and mismatched Incident report defaults
with one immediately useful, read-only health-check Workflow for each shipped
target Agent.

## Decisions

- Ship Kubernetes health check and Virtual machine health check as the two
  automatic Workflows.
- Keep both Workflows direct, read-only, and bound to exactly one compatible
  target. Their prompts explicitly cover the evidence available from AgentK
  and AgentV and prohibit changes.
- Use new internal and public template identities so existing workspace-owned
  defaults are not mislabeled or silently overwritten.
- Preserve the existing opt-in remediation and incident-investigation
  Workflows for later redesign.
- The initial v6 implementation added optional AgentV service restart to the VM
  Agent ceiling. Version 7 removed it because strict readiness correctly treated
  the default absence of `restart_service` as missing setup. See
  `virtual-machine-agent-readiness.md` for the correction.

## Work

- [x] Replace the two automatic Workflow templates and increment the bundle.
- [x] Update lifecycle, provisioning, and template tests.
- [x] Align management-console fixtures and public docs.
- [x] Run focused and repository validation.

## Validation

- `node --import tsx --test --test-concurrency=1 test/automation-templates.test.ts test/repository-development-seed.test.ts`: 3 passed.
- PostgreSQL-backed `test/workflow-foundations-postgres.test.ts`: 5 passed against a disposable migrated database.
- Control-plane typecheck, build, style, migrations, authorization, membership,
  run-event, contract, and harness checks passed.
- `npx vitest run src/fixtures/router.test.ts`: 8 passed.
- The updated default-workflow edit flow passed in Playwright; the renamed
  recommendation flow passed independently. The broader UI run retained one
  unrelated workflow-navigation failure.
- Management-console UI package typecheck passed. Full application lint remains
  blocked by unrelated missing `resolveTargetGitSkill` and `TextInput` symbols.
- Full management-console Vitest run: 776 passed and 2 unrelated layout/i18n
  contract tests failed.
- Docs validation and broken-link checks passed.
- Workspace runtime-truth checks passed.
- The control-plane OpenAPI check remains blocked by a stale artifact caused by
  concurrent API-contract edits outside this change.
