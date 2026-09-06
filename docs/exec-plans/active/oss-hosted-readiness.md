# OSS hosted readiness

## Scope

Implement optional external workspace policy control and five independent execution
pools without adding billing, pricing, spend limits or a cloud dependency. Preserve
existing self-hosted defaults, role checks, tenant isolation and BYOK behavior.

## Design

- Transactional versioned policy mutations, request receipts and admin audit.
- Independent administrative/external suspension holds and safe member discovery.
- PostgreSQL reservations, fenced grants and bounded operation records for Chat,
  Agent, Workflow, auto-triage and Insights. Workflow children use Workflow capacity.
- Durable admission/dispatch, approval and coordinator continuation recovery.
- Quiesced rollout with replica capability checks and immutable catalogue hashes.

The [runtime guide](../../workspace-execution-capacity.md) describes the implemented
invariants. The parent workspace's approved implementation plan coordinates the
engine, gateway, consoles, deployment and public documentation changes.

## Verification

Use isolated PostgreSQL and Redis for the repository suite, migration/backfill
checks and the explicit two-control-plane/two-engine replica probe. Check policy
idempotency, concurrent pool admission, ownership expiry, uncertain operations,
rapid suspension/restoration, approval recovery and coordinator concurrency one.
Run the full repository validation and counterpart contract checks before handoff.

## Progress

Implementation and independent reviews are complete, including native-tool
authority at document and Fetch boundaries. Full validation passed 1,284 tests,
SQL upgrade checks, contracts and build. Replica, Docker integration and console
browser acceptance are recorded in the parent handoff. Keep this plan active
until the coordinated change lands, then move it to completed/.
