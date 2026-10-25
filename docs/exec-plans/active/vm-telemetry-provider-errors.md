# VM telemetry repair

Status: in progress, 2026-10-25.

User scope: repair missing VM card telemetry, improve provider-credit error
guidance, release affected services, and update the demo without unrelated changes.
Branch: `fix/vm-telemetry-provider-errors` in the current checkouts.

## Evidence and design

The demo rejects AgentV snapshots with duplicate inventory keys for processes
named `MainThread`. Snapshot, inventory, and metric writes share a transaction,
so the failed insert leaves no telemetry. Process names are display labels, not
identities. Listener protocol/port also collides across bind addresses.

Use PID for process identity and protocol/address/port/PID for listener identity;
retain existing display labels. Disambiguate repeated inventory identities within
one snapshot without dropping rows. Do not change AgentV, its protocol, the UI,
database schema, credentials, permissions, or snapshot atomicity. New snapshots
replace derived inventory normally; no migration or historical backfill is needed.

## Checks

- [x] Add a repository regression using same-name processes, same-port listeners,
  and repeated listener entries. Confirm the test fails on duplicate row IDs.
- [x] Make the bounded inventory-ID correction and confirm unique rows, preserved
  display data, and metric writes through the existing repository boundary.
- [x] Run the targeted test and `npm run validate`; run platform contract checks.
- [x] Review the combined diff with the gateway change before merging/releasing.
- [ ] Publish a new control-plane image after CI passes. Update only affected demo
  image pins; preserve AgentV and all persistent data.
- [ ] Verify fresh metric samples for the affected VM after rollout, normal app
  readiness, and absence of the snapshot duplicate-key failure.

The companion gateway plan is `llm-gateway/docs/exec-plans/active/provider-credit-guidance.md`.
Release evidence and any limitations will be recorded here before completion.

## Validation evidence

- Regression first failed with 4 unique IDs for 8 inventory rows; all 8 repository
  tests passed after the correction.
- `npm run validate`: 1,314 tests passed, with type, build, migration-chain,
  authorization, membership, event-durability, contract, OpenAPI, and harness checks.
  Used disposable PostgreSQL/Redis instances, not the local development stack.
- Real PostgreSQL smoke: two snapshots with repeated process names and listener
  endpoints persisted all inventory rows and CPU/memory history successfully.
- Workspace platform contract checks and 29 existing console chat/telemetry tests
  passed. No frontend or AgentV change is required.
- Independent combined review found no blocking or minor findings.
