# AgentV 0.0.1-experimental.6 release pin

## Goal

Generate AgentV enrollment, repair, and credential-replacement commands against
the exact immutable `0.0.1-experimental.6` systemd release.

## Outcome

- Updated the default and example `AGENTV_SYSTEMD_RELEASE_VERSION` value.
- Kept enrollment, transaction, AgentK, and WebSocket contracts unchanged.
- Updated install-instruction and configuration expectations so every generated
  bootstrap URL remains exact and version-pinned.

## Validation

- `npm run validate` passed all 1,134 tests plus typecheck, style, migrations,
  authorization, membership, run-event durability, contracts, OpenAPI, harness,
  and build checks against an isolated disposable PostgreSQL database.
- The local LLM gateway was explicitly isolated from the test process to avoid
  importing live development-stack tool state.

## Release impact

Release as control plane `0.0.1-experimental.34` only after the matching AgentV
assets exist.
