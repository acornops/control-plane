
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
contract, OpenAPI, harness and build gates. Exact-commit GitHub CI remains the
release gate. Evidence: `/tmp/acornops-main-demo-rollout-20261029/`.
