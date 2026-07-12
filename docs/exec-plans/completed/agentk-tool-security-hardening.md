# AgentK Tool Security Hardening

## Goal

Align the control-plane handshake, built-in catalog, synchronization, and
contracts with AgentK's hardened six-tool surface.

## Constraints And Decisions

- Remove `apply_remediation` without a database migration; discovery reconciliation removes it.
- Preserve run-scoped authorization before forwarding calls.
- Keep session policy mandatory and limited to canonical AgentK tools.
- Preserve execution-engine tool call identity through local and distributed
  agent routing, and retain sanitized AgentK timeout outcome data.

## Validation Log

- `npm run validate`: passed; 539 tests plus migration, authorization,
  membership, event-durability, contract, OpenAPI, harness, and build checks.
- Stale built-in remediation removal test: passed.
- Workspace validation: passed.

## Completion Criteria

Control-plane validation and mirrored AgentK contract checks pass.
