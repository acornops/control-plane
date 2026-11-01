# Agent heartbeat freshness

The user approved a focused heartbeat-based correction to connection reporting
for AgentV (Linux and Windows) and AgentK. The stored lifecycle/health status can
survive a missed disconnect; public connection observations must expire without
requiring an agent reconnect or a background database writer.

## Scope and boundaries

| Concept | Owner | Change |
| --- | --- | --- |
| Heartbeat receipt and observation | Shared control plane | Record only the matching connection; expose bounded freshness. |
| Connection display, filters and counts | Shared management console | Use the observation consistently and age cached results. |
| OS collectors, agent wire protocol and installers | AgentV/AgentK | Unchanged. |
| Ownership, routing, permissions and persistent health | Existing backend lifecycle | Preserve authority and existing behavior. |

Use an additive `connection` observation on target, VM and Kubernetes read
responses: `{ state, lastHeartbeatAt, observedAt, expiresAt, hasConnectionEvidence }`. `state` is
`connected`, `disconnected` or `unknown`; timestamps are ISO8601, with nullable
heartbeat/expiry. `status` remains the persisted lifecycle/health value. Existing
status query filters retain that meaning. Connection-oriented console filters,
counts, admin connection reporting and target MCP connection output use freshness.

Evaluate with server time. The configurable
`CONTROL_PLANE_AGENT_HEARTBEAT_FRESHNESS_SECONDS` defaults to120 and accepts60–600.
A known offline lifecycle wins immediately. An online/degraded target requires
its persisted connection identity and a valid, nonfuture heartbeat younger than
the grace period. Exact expiry means disconnected. Missing or invalid evidence
means unknown. Never-connected VM onboarding and Kubernetes onboarding remain
distinct from an unavailable observation. Snapshot collection failure does not
invalidate a current heartbeat. `last_seen_at` is not liveness evidence because
disconnect paths also update it.

Periodic heartbeats use server receipt time captured before asynchronous checks,
then a database update guarded by the exact persisted connection ID. Older writes
must not move the timestamp backward. Keep authentication-generation handling
compatible. Initial heartbeat evidence belongs with the accepted online identity;
a failed handshake must not make a previous connection look fresh. Do not change
Redis retry, claim, renewal, shutdown or command dispatch behavior.

The console uses the backend observation and its remaining validity when received,
so client clock skew does not manufacture freshness. Cached data retains its
original receipt time and ages during failed refreshes. Missing observations from
an older backend retain the legacy mapping for staged compatibility; invalid new
observations fail to unknown. Deploy the backend before the new console.

## Approach

Use a shared backend read projection and a shared console freshness helper.
A UI-only snapshot-age rule leaves API/MCP reporting inconsistent and confuses
collection failure with connectivity. A recurring persistent status writer needs
the separate ownership protocol design and is outside this change. The approved
approach adds no migration, agent release, durable disconnect event or ownership
cleanup guarantee. Reachability remains a recent observation; execution retains
its existing live socket, ownership and authorization checks.

## Validation

Prove fresh/expired/exact-boundary/null/future input, offline and degraded status,
never-connected setup, successful reconnect, failed handshake, delayed old-ID
heartbeat, monotonic receipt ordering, cached expiry, API failure, and filter/count
consistency. Use real PostgreSQL for receipt guards/read projection and existing
real Redis lifecycle regressions. Run full backend and console validation,
targeted browser coverage and cross-repository contracts/integration. Review the
complete scoped change independently. Keep all work on feature branches and
leave Windows rollout and the broader outage-status repair disabled.

Review refinement: retain `hasConnectionEvidence` even when an unusable heartbeat
is normalized to null. Only absent evidence can imply initial setup. A Kubernetes
attempt that closes during its final identity write invalidates that identity's
heartbeat before releasing its owner, without clearing a replacement or changing
stored status. Durable recovery from a failed cleanup still belongs to the
separate repair design.
