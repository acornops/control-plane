# VM Metric Snake-Case Compatibility

## Goal

Restore memory, swap, and root-disk values in virtual-machine metric history
when snapshots are produced by AgentV.

## Cause

AgentV snapshots use snake-case byte fields such as `used_bytes` and
`total_bytes`. The control-plane history mapper currently reads only the
camel-case equivalents from stored metric samples, so these values become
`null` while independently normalized CPU usage remains available.

## Change

- Accept both snake-case AgentV fields and legacy camel-case stored fields.
- Preserve the existing public VM metric-history response shape.
- Cover the real AgentV snapshot-to-history path and historical stored samples.

## Cross-Repository Boundary

- Producer: AgentV snapshot v2, unchanged.
- Normalizer: control-plane VM metric history, compatibility fix.
- Consumer: management-console VM catalog, already reads the public camel-case
  metric-history response.
- Contract impact: none. No public field or route changes.
- Suggested shared branch slug for publication: `fix/vm-card-telemetry`.
- Merge order: control-plane first, then management-console.

## Validation

- `node --import tsx --test test/virtual-machine-metrics-history.test.ts`
  passed, including a real AgentV snake-case snapshot fixture.
- `npm run typecheck` passed.
- `npm run contracts:check` passed.
- `npm run harness:check` passed.
- `npm run validate` completed type checking and style checks, then reported
  932 passing tests and 149 infrastructure-dependent failures because
  `CONTROL_PLANE_TEST_DATABASE_URL` is not configured in this workspace. The
  failures are PostgreSQL fixture hooks outside VM metric history.
- Management-console focused unit tests passed (2 files, 6 tests), its focused
  catalog browser suite passed (5 tests), and both affected design routes
  passed across all 5 responsive/color projects.
- Management-console `npm run build` passed after the final card changes.
- The workspace platform-contract check could not run because the existing
  `control-plane/test/fixtures/workflow-template-conformance.json` fixture is
  absent. The control-plane repository's own contract check passed, and this
  compatibility fix does not change a public contract.

## Outcome

The mapper now accepts both historical camel-case fields and AgentV's
snake-case fields. Existing stored samples are repaired at read time, so no
data migration is required.
