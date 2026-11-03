# Windows/shared status characterization

Approved scope: tests only for the existing Linux/Windows status boundary.
Design: [VM status repair](../../design-docs/vm-connection-status-repair.md).
Coordinated plan: AgentV `docs/exec-plans/completed/windows-qualification-preparation.md`.

- [x] Add real PostgreSQL/Redis delayed-missing-response characterization and committed-replacement fencing tests for legacy Linux and Windows.
- [x] Assert metadata/settings/admin state are preserved by stale exact-ID cleanup.
- [x] Run targeted tests and full `npm run validate` against isolated migrated stores, with no skips.
- [x] Independent review; commit and push feature branch; record CI evidence.

No production/schema/contract change. The periodic repair/ownership protocol
design gate remains open. Tests document the current intermediate offline state
before replacement SQL publication; they do not assert cross-store atomicity.

## Completion evidence — 2026-11-01

Source commit `85d6ff656c093643412cad8706018fb61f29f725`, branch
`feat/windows-vm-support`, draft [PR33](https://github.com/acornops/control-plane/pull/33).
The production `src/` tree is byte-identical to `0b589ae`.

- New targeted real-store suite: 10/10 pass for legacy Linux and Windows.
- Full local `npm run validate`: 1,741 tests/256 suites, zero failures/skips;
  type/style, migrations, authorization, membership, run-event durability,
  contracts/OpenAPI, harness and build pass against disposable PostgreSQL16/Redis7.
- [Hosted CI41317879789](https://github.com/acornops/control-plane/actions/runs/41317879789):
  same 1,741 tests/256 suites and required checks pass at tested merge
  `05fab7ac770e8c2dce897e1a6c1f7e25ff5ffb6e`. Full log retained.
- Independent read-only review: no Critical, Important or Minor findings.

Tests characterize existing behavior; they are not a new outage-status repair.
The protocol design gate, actual Windows reboot/native-backend qualification and
Windows activation remain open. No source, schema, policy or public contract
changed, and no merge/deployment was performed.
