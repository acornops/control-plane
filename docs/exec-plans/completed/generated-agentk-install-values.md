# Generated AgentK Install Values

## Goal

Add safe platform defaults for downstream AgentK Helm values and a dedicated
operator-local CA file binding in generated cluster install commands.

## Decisions

- Preserve the existing install API response and default command.
- Render literal values with `--set-json` and the CA path with `--set-file`.
- Reject control-plane-owned value paths and conflicting CA sources.
- Keep configuration parsing in a focused AgentK Helm module.

## Validation

- Focused install-instruction tests passed (11 tests).
- Typecheck, style, harness, static migrations, authorization, membership,
  run-event, contract, OpenAPI, and build checks passed.
- The full suite requires an external `CONTROL_PLANE_TEST_DATABASE_URL`; it was
  not available in this workspace.

