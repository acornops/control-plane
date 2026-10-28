# Graceful rolling restarts

Central plan: `acornops-deployment/docs/exec-plans/active/2026-10-29-graceful-rolling-restarts.md` in the sibling workspace.

- Track accepted HTTP handlers through promise settlement, even after disconnect.
- Close admission and readiness before draining agent commands, RPC reply publication and background dependency users.
- Fence owner drain state and handshake/authorization races; wait for ownership replacement only before dispatch.
- Add remaining-lease and durable cancellation contracts without schema changes.
- Validate focused race tests, PostgreSQL/Redis cases and the repository validation entrypoint. Preserve unrelated planning files.

Base: `0f6e1dd3c83fb09c7844e4aea183e7fa9ef43dc5`.


## Completion evidence

- Implemented first-signal HTTP admission/readiness closure, monotonic drain and bounded cleanup.
- Accepted HTTP handlers, callbacks, agent commands and RPC publication retain their dependencies.
- Agent handoff preserves bounded fenced reconnect markers while persisting truthful offline state; durable run and capacity authority are revalidated before send.
- Remaining-lease and bounded service-token cancellation contracts are additive, with no migration.
- Independent review identified reconnect-gap, durable-cancellation and Express arity issues; regressions reproduce each and fixes pass.
- Final `npm run validate` passed on isolated PostgreSQL/Redis: 1,416 tests, zero failures, then all structural/contract/OpenAPI/build checks.
- Real process tests cover accepted work through SIGTERM, repeated signals, deadline expiry, preauth sockets and mutual TLS. Real Redis checks cover draining renewal and replacement fencing.
- Replayable SSE observers close after accepted replay; resumed handoff checks stay deadline-fenced until the synchronous dispatch boundary.
- Parent deployment task owns routed cross-service rollout acceptance. No production deployment or existing user stack restart occurred.
