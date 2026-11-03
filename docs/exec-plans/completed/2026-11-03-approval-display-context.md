# Approval display context

## Scope and design

The console must show readable approval identities and context while keeping the
decision separate from tool execution. Add optional requester/decider display
identities, workspace and target names to existing approval responses, and pass
target identity and execution status through the workspace inbox. Stable IDs and
tool references remain authoritative. No database migration or policy change.

Use set-based joins from each persisted approval to its referenced users and
workspace. Historical actors remain readable after membership removal. Target
names must match the approval workspace. Missing users/targets leave optional
display fields absent. Select only user IDs and display names, never email.
External integration projections keep their existing allowlist.

Final review found that OIDC may persist an email address as `display_name`.
The approval mapper therefore omits email-shaped actor labels, including names
containing an address, and keeps stable requester/decider IDs for the console
fallback. Two real-database regressions cover interactive and workflow creation,
decision, detail and inbox responses; normal names remain covered.

Integration with current remote main (`a8f2b0a`) retains its Windows/heartbeat
changes. The generated docs-website public API reference has exactly 13 optional
property additions (+107 lines); the admin artifact is unchanged. OpenAPI size
budgets increased by 150 lines to accommodate this measured schema growth;
determinism, artifact-staleness, path and schema checks remain enforced.

The integrated shared domain types reached 551 lines against a 550-line budget.
`RunToolApproval` now lives unchanged in the focused `approvals.ts` module and
is type-re-exported from `domain.ts`, retaining existing import compatibility.
Transpilation confirms identical runtime JavaScript for both affected files.

## Final pre-merge verification

- Fresh `npm run validate` with dedicated `ux_merge_test` and
  `ux_merge_migration_test` databases on port 55449 and Redis on 56449 passed
  1,777/1,777 tests (zero skips), migration static/SQL upgrade, authorization,
  membership, event durability, contract and OpenAPI checks. The wrapper then
  stopped at the domain-file size guard described above.
- After the type-only extraction, `npm run typecheck`, `npm run style:check`,
  `npm run harness:check`, `npm run openapi:check` and `npm run build` passed.
  The emitted-JavaScript equivalence check confirms no runtime change after
  the full suite, so that full runtime suite was not repeated for moving types.
- Post-extraction approval presentation, workflow architecture and pod-log
  regressions passed 22/22 tests with the same isolated test environment.
- The new privacy regressions first failed for both interactive/workflow
  email labels, then all 8 approval presentation tests passed after the fix.
- Independent review approved the privacy fix and narrow OpenAPI-budget update.
- Docs-website `npm run validate` and `npm run links` passed after exporting
  the generated public schema; admin output remained byte-identical.
- The current local AgentV checkout predates its Windows contract files. An
  isolated contract-only snapshot from AgentV `origin/main` at `b7df481` passes
  the full platform contract checker with these producer/consumer branches.
  No AgentV source or branch was changed.

Fresh evidence is stored by the coordinating task in `evidence/merge/`.

## Tasks

- [x] Add failing real-database regression tests for interactive and workflow
  inbox/detail/decision responses, failed execution, deleted references and scope.
- [x] Implement joined presentation projections and inbox fields.
- [x] Update public OpenAPI and producer contract manifest/README; coordinate
  consumer mirror with the console owner.
- [x] Run focused regressions and full `npm run validate`; record outcomes.

## Validation and handoff

Worktree `fix/console-ux-clarity`; no deployment or remote mutation.
Disposable local PostgreSQL/Redis containers used ports 55449/56449 and were
independent of running platform/demo services.

- RED: `node --import tsx --test --test-concurrency=1 test/approval-display-context-postgres.test.ts`
  failed three expected missing-context assertions; authorization baseline passed.
  Evidence: `/tmp/approval-clarity-red.log`.
- GREEN: the new display-context test plus `repository-run-approvals`,
  `runs-approvals`, `workflow-run-approvals-postgres`, and
  `workflow-schedules-approvals` passed 35/35 tests. Evidence:
  `/tmp/approval-clarity-green.log`.
- Full-suite first pass: 1621/1622 passed. The architecture guard correctly
  rejected target fields in the Workflow schema module, because the generic
  inbox schema was located there. Moved inbox schemas into the shared approval
  schema module without changing or weakening the guard. The isolated guard
  then passed 8/8; display/security/query-bound and architecture checks together
  passed 14/14. Evidence: `/tmp/approval-clarity-final-targeted.log`.
- `npm run typecheck`, `npm run contracts:check`, `npm run openapi:check`,
  `npm run harness:check`, and `git diff --check` passed. Contract checking
  explicitly skipped the docs-website/console route inventory because that
  counterpart is absent from this worktree; root owns platform validation.
  A temporary counterpart link also passed route inventory checking. The
  original checkout's generated OpenAPI artifacts have pre-existing version
  drift, independently reproduced by root; those files remain unchanged.
  Root preserves standalone generated artifacts for this coordinated change.
  Root also confirmed existing whole-platform contract drift around Windows VM
  support and `agentConnectionObservation` is unchanged; approval boundary
  producer/consumer manifests match. Independent review reported no findings.
- Final `npm run validate` passed (exit 0): 1624/1624 tests, zero failures or
  skips; migration static/SQL upgrade, authorization, membership, durable-event,
  contract, OpenAPI, harness and build checks all passed. It ran with `NODE_ENV=test`, dedicated
  `DATABASE_URL`/`CONTROL_PLANE_TEST_DATABASE_URL` (approval_clarity_test),
  `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL` (approval_clarity_migration_test),
  and `REDIS_URL` pointing to the disposable services. Evidence:
  `/tmp/approval-clarity-validate-final.log` (fresh pass after schema relocation).

Exact full-validation invocation (against the disposable test services):

```sh
NODE_ENV=test \
DATABASE_URL=postgres://approval_test:approval_test@127.0.0.1:55449/approval_clarity_test \
CONTROL_PLANE_TEST_DATABASE_URL=postgres://approval_test:approval_test@127.0.0.1:55449/approval_clarity_test \
CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL=postgres://approval_test:approval_test@127.0.0.1:55449/approval_clarity_migration_test \
REDIS_URL=redis://127.0.0.1:56449 \
npm run validate > /tmp/approval-clarity-validate-final.log 2>&1
```

The final focused invocation used the same runtime test environment with
`node --import tsx --test --test-concurrency=1 test/approval-display-context-postgres.test.ts test/workflow-execution-architecture.test.ts`.
No Compose integration bringup was needed for this response-only change; run
dispatch, gateway behavior and authorization enforcement are unchanged.

`toolServerName` was not introduced: gateway registry owns the current label,
and approval presentation must not add gateway requests. Console preserves an
explicit server-ID fallback. Names are optional additions; producer-first
rollout and consumer-first rollback remain compatible. All DB references use
existing rows and indexes; no migration is required.

Implementation and local validation are complete; integration and deployment
remain with the coordinating workspace owner. No commits or remote mutations
were made by this task. Disposable local test services were removed after the
final checks; evidence logs remain under `/tmp/approval-clarity-*.log`.
