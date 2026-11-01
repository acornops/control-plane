# VM connection status repair

Status: design gate; shared runtime unchanged. This follow-up applies to Linux and
Windows VMs. It is separate from the Windows-specific hardening implementation.

## Problem and current boundary

An ordinary disconnect is fenced by the exact persisted connection identity and
target-first/registration-second row locks. That exact-ID ordinary disconnect path preserves metadata
and protects a replacement already committed to PostgreSQL; failed-handshake
cleanup instead relies on ownership/local checks and does not supply a departing ID. If the dependency
operation fails or the process dies, that callback has no durable retry. The row
can remain online until another connection attempt performs cleanup. This outage
repair gap is inherited; adding Windows does not create it.

The relevant paths are `src/agent/vm-connection-lifecycle.ts`,
`src/store/repository-vm-connections.ts`,
`src/services/control-plane-coordination/agent-owner.ts`, and `src/server.ts`.
Redis ownership and PostgreSQL status are explicitly non-atomic in the existing
[VM connection contract](../contracts/README.md#vm-connection-status).

| Concept | Boundary | Required preservation |
| --- | --- | --- |
| VM connection identity/status | Shared Linux/Windows VM lifecycle | Exact identity, metadata, settings and administrative status |
| Coordination ownership | Shared infrastructure | Existing Kubernetes callers and mutating client behavior |
| Repair scheduling | VM-specific backend service | Tracked work, bounded shutdown, no agent reconnect dependency |
| OS collectors and tools | AgentV adapters | No changes |

## Smallest candidate and the unresolved race

The persisted online VM row with a nonempty `last_connection_id` is already durable
work. A bounded periodic scan needs no retry queue. A candidate transaction would
lock target then registration, recheck online status and the expected identity,
exclude local connections/pending attempts, and require an authoritative missing
Redis key before clearing only that identity. Any present owner, including a
draining owner, blocks repair. Errors, malformed values, disabled coordination and
timeouts must never become absence; the existing `getAgentOwner()` returns
`undefined` for multiple cases and cannot authorize this worker.

That small scan protects **committed** replacement identities. It cannot make a
cross-store observation atomic:

1. Repair locks the database row for A; Redis executes GET and finds no owner.
2. The missing response is delayed. Another replica claims owner B in Redis.
3. Repair receives the old absence, commits A offline, and releases its row lock.
4. B's database transaction can then commit B online.

The worker has not cleared a committed B, but may expose an intermediate offline
status after B claimed ownership. Two reads, a grace period, or a worker lease do
not close the gap. Moving SET into the database lock alone also does not fence a
queued/ambiguous Redis write that executes after the SQL connection dies.

The conservative hardening boundary is to **not add this recurring writer now**.
The follow-up must first define whether live means claimed in Redis or published
after SQL commit and final ownership checks (the current publication boundary).
This hold conservatively protects the earlier claim boundary; the example does
not show a published B being cleared. A reviewed ownership/rollout contract
must precede a claim that stale observations cannot offline a live replacement.
The existing callback behavior stays unchanged. The cost is that outage-induced
stale online rows remain an explicit operational gap.

## Follow-up acceptance

Repair must work after process restart and dependency recovery without an agent
reconnect. Its authority must be explicit: one durable generation/lease governs
claim, renewal, close, failed handshake, dispatch, heartbeat and draining. A
PostgreSQL-authoritative generation is a candidate, not an approved implementation.
Do not add a migration or change any of those paths until the protocol and its
mixed-version rollout/rollback are specified and independently reviewed.

A read-only observation result must distinguish `present`, `absent`, `unavailable`
(timeout/transport/invalid), and `disabled`. Only a successful raw Redis GET of null
may mean absent. Use a separate bounded read connection if Redis remains involved;
never change retries/queuing on the existing mutating client incidentally.
Cancellation must stop pending I/O and invalidate continuations, not merely win a
Promise race while a callback can still issue a later write. SQL lock, statement,
idle-transaction, connection and overall transaction lifetimes must be bounded (pool acquisition already has a
five-second limit);
a lost COMMIT response is uncertain success, not proof of rollback.

The worker must use fair keyset pages with bounded inspected rows, one tick per
process, capped attempts and admission time, and one tracked cleanup deadline.
Advance only past examined work, including pages with no eligible VM; wrap at the
end. Skip uncertainty/contention and retry later. No per-target outage log flood,
no mutation of owner keys, sockets, metadata, permissions or key/enrollment state.
Disabled distributed coordination cannot establish remote absence; multi-replica
repair stays disabled without a proven ownership authority for that topology.

Notifications currently occur after SQL commit; exactly-once/durable events are
not implied. A durable event guarantee would require an outbox write in the same
transaction and its own explicit scope.

Real PostgreSQL and Redis tests must cover delayed missing replies, replacement
before/after locks, late operations after cancellation, actual TTL/renewal,
dependency failure during close/commit, process death/restart, two repair replicas,
settings/admin-status races, fair pagination and shutdown. In-memory mocks do not
establish these guarantees. Parameterize Linux (including legacy missing OS
metadata) and Windows; keep Kubernetes checks unchanged.

## Executable characterization

`test/vm-connection-repair-ownership.test.ts` uses real PostgreSQL and Redis.
Its barriers delay an actual missing GET reply across B claiming ownership, then
allow B to publish after A commits offline. It asserts that existing intermediate
state, final B identity, and committed-B protection with both present and absent
Redis ownership, edited settings and administrative degraded status. Legacy
Linux and Windows share the tests. These tests do not implement a periodic
repair worker or close the protocol design gate.
