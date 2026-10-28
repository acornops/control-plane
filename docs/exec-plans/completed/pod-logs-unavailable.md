# Explain logs unavailable before container startup

2026-10-29. Shared branch: `fix/console-log-polish` in AgentK, Control Plane,
and Management Console. User requested this small follow-up and a main push.

- [x] Test the controller through real MCP result unwrapping, including unrelated
  failures and successful logs.
- [x] Map only `PRECONDITION_FAILED` / `ContainerNotStarted` / upstream status
  400 to `POD_LOGS_UNAVAILABLE` (409), with safe constant copy and no auto retry.
- [x] Update OpenAPI and mirrored contracts; validate, review and commit/push main.

No transport, authorization, migration, dependency or deployment changes. Older
components retain generic errors; the improved message requires all three updates.

Validation with Node 22.23.1:

- `NODE_ENV=test node --import tsx --test test/kubernetes-pod-logs.test.ts`:
  the new case first reproduced HTTP 502 instead of 409; after implementation,
  all 6 tests passed through real MCP result unwrapping.
- `npm run validate` with `NODE_ENV=test`, matching `DATABASE_URL` and
  `CONTROL_PLANE_TEST_DATABASE_URL` pointing to this task's disposable
  `acornops_console_polish_test` database, and a dedicated localhost Redis:
  types/style, all 1,388 tests, migrations, authorization, membership and
  run-event checks passed. The initial run without a test database hit the
  fixture guard and was stopped. Existing migrations were applied using
  `npm run db:migrate` before the isolated rerun.
- The isolated validation first stopped at `contracts:check` because the copied
  counterpart manifest lacked its required LLM-gateway source file. Supplying
  that unchanged source from `origin/main` and regenerating API docs completed
  the remaining gate: `npm run openapi:export && npm run contracts:check &&
  npm run openapi:check && npm run harness:check && npm run build` all passed.
- Workspace `node scripts/harness/check-platform-contracts.mjs`: passed against
  the changed worktrees and unchanged counterpart main manifests.
- Independent read-only review: no actionable findings.
- `git diff --check`: passed.

Docs impact: mirrored AgentK/console invariants, OpenAPI source and the generated
`docs-website/openapi/control-plane-public.json` response. No database migration
or lifecycle change, so full-stack lifecycle/RBAC suites and SQL-upgrade testing
were not required. Validation logs are in `/tmp/acornops-console-publish/`.

The user requested direct main publication, so no PR is created. The coordinated
source commits include AgentK, Control Plane, Management Console and generated
API documentation. Deployment is separate; updated versions of the three runtime
components are needed for the improved message.
