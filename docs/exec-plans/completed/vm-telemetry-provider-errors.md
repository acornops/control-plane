# VM telemetry repair

Status: completed, 2026-10-25. Control-plane `.36` is verified in the demo.

User scope: repair missing VM card telemetry, improve provider-credit error
guidance, release affected services, and update the demo without unrelated changes.
Implementation branch: `fix/vm-telemetry-provider-errors` in the current checkouts.

## Evidence and design

The demo rejected AgentV snapshots with duplicate inventory keys for processes
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
- [x] Publish a new control-plane image after CI passes. Update only affected demo
  image pins; preserve AgentV and all persistent data.
- [x] Verify fresh metric samples for the affected VM after rollout, normal app
  readiness, and absence of the snapshot duplicate-key failure.

The companion gateway plan is `llm-gateway/docs/exec-plans/completed/provider-credit-guidance.md`.

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
- PR #26 merged as `6b67b53fa2956156c507d4e5233a3e21459bc512`. Main CI
  40160701809 and release 40161171126 passed; published `.36` OCI index
  `sha256:1c62a79c7aba09ffb04b2a1b1c9eac50a56dd5ef7e13f49d8f204adebf2f356e`.
  Demo commit `60a91ca` updates only the two affected service pins/defaults;
  rollout 40162896202 passed and released its deployment lease.

## Live acceptance

- Before rollout the affected VM was online with no snapshot and zero metric
  samples. After rollout it remained online with two fresh persisted samples at
  `2026-10-25T04:53:17.327Z` and `2026-10-25T04:53:35.472Z`. The same mapper used
  by the API returned non-null CPU, memory, and root-disk percentages.
- Read-only assertions required at least two samples, a latest sample less than
  three minutes old, and valid CPU/memory values. All passed. New control-plane
  pod logs contained zero `target_inventory_items_pkey` duplicate-key errors.
- Both service image IDs matched their published digests; all five demo services
  were ready. `task demo:verify DEMO_ENV_FILE=.env.demo` passed all public and
  host/Kubernetes checks. Helm revision advanced from 4 to 5 on the same chart;
  all three persistent-volume UIDs remained unchanged.
- No teardown, AgentV reinstall, schema change, credential/policy change, paid
  provider request, or mutation of the enrolled VM was performed. New snapshots
  recover telemetry automatically; historical failed samples are not backfilled.
- Authenticated demo-browser verification was not performed. The unchanged
  console's existing telemetry tests passed, and live backend data/mapping was
  verified directly without bypassing sign-in or making a paid request.
