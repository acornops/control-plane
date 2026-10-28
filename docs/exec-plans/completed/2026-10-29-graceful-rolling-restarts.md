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

## Release CI qualification

The fresh local aggregate passed all 1,475 tests and SQL migration upgrades.
Linux Node 22 CI exposed a test-harness lifetime issue: fake EventEmitter
connections provided no referenced socket while waiting for an unreferenced
authorization interval. Reproduced both cancelled tests in a standalone Node
22.23.4 container, then added a bounded referenced wait and cleanup in the tests.
Application lifecycle code is unchanged. The corrected Linux coverage run passed
1,474 tests; its sole failure was the slim fixture image missing OpenSSL. After
installing the CI prerequisite, both native signal/TLS tests and both stream
tests passed, followed by migration, authorization, membership, run-event,
contract, OpenAPI, harness and build gates. Exact-commit GitHub CI passed all gates on `c52a7a51e42f90bdf6277801ee7682766f7c1fe3`
([run 40779272807](https://github.com/acornops/control-plane/actions/runs/40779272807)).
Release `0.0.1-experimental.42` passed image publication and its OCI provenance
matches that source revision. Coordinated demo acceptance is recorded by
demo-infra; actual production promotion remains a separate deployment. Evidence: `/tmp/acornops-main-demo-rollout-20261029/`.
