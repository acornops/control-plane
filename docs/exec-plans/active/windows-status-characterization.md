# Windows/shared status characterization

Approved scope: tests only for the existing Linux/Windows status boundary.
Design: [VM status repair](../../design-docs/vm-connection-status-repair.md).
Coordinated plan: AgentV `docs/exec-plans/active/windows-qualification-preparation.md`.

- [ ] Add real PostgreSQL/Redis delayed-missing-response characterization and committed-replacement fencing tests for legacy Linux and Windows.
- [ ] Assert metadata/settings/admin state are preserved by stale exact-ID cleanup.
- [ ] Run targeted tests and full `npm run validate` against isolated migrated stores, with no skips.
- [ ] Independent review; commit and push feature branch; record CI evidence.

No production/schema/contract change. The periodic repair/ownership protocol
design gate remains open. Tests document the current intermediate offline state
before replacement SQL publication; they do not assert cross-store atomicity.
