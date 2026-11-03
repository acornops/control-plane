# Target Insights context role repair

## Cause and scope

After checkpoint generation resumed, relevant Target Insights could be retrieved
for Kubernetes and VM triage. The context producer prepended this evidence as a
`system` message, while the unchanged Execution Engine context contract permits
only `user` and `assistant`. A retrieval miss avoids the invalid message, so an
ordinary conversation can work while focused issue triage fails.

Restore that existing contract at the Control Plane producer. Keep retrieved
evidence in the conversation at user priority, explicitly identify it as
untrusted reference data, and preserve snippet metadata and conversation order.
Do not broaden the Engine's trusted instruction boundary or disable Insights.

## Steps

- [x] Reproduce the retrieval-hit failure for Kubernetes and VM contexts.
- [x] Add the minimal producer correction and role typing; verify hit and miss
  cases plus the real Engine context/transcript consumer.
- [x] Run canonical validation, cross-service integration and independent review.
- [x] Merge/push current-main source, publish a fresh Control Plane image and
  update only the demo Control Plane pin through the normal deployment workflow.
- [x] Verify deployed provenance, retained state and Kubernetes/VM context reads.

User authorized main pushes, a new release and demo rollout. Existing unrelated
drafts in main checkouts remain untouched. Deployment evidence and exact command
results are recorded under `/private/tmp/acornops-triage-context-20261103`.

## Implementation and validation

- The two retrieval-hit regressions failed with a leading `system` role before
  the correction; both miss cases passed. All six tests in
  `NODE_ENV=test node --import tsx --test test/internal-execution-target-insights.test.ts`
  now pass, including retrieval error/disabled handling.
- `npm run validate` passed 1,797 tests across 261 suites with zero failures or
  skips, plus type/style, migration, authorization, membership, event durability,
  contracts, OpenAPI, harness and build checks. It used disposable PostgreSQL
  on localhost:56432 and Redis on localhost:57379, `NODE_ENV=test`, matching
  `DATABASE_URL`/`CONTROL_PLANE_TEST_DATABASE_URL`/migration-test URL for
  `acornops_control_plane_test`, and the canonical docs-website public OpenAPI.
- Engine `task validate` passed 459 tests and 29 keyless evaluations. The only
  Engine change clarifies the existing contract; runtime models remain strict.
  `node scripts/harness/check-platform-contracts.mjs` passed after both main
  branches were updated.
- Actual emitted controller fixtures passed the unchanged Engine model and
  provider transcript compilation for OpenAI, Anthropic and Gemini. Replacing
  the first role with the legacy `system` reproduces the reported literal error.
  Insight content remains in the transcript and outside trusted instructions.
- The isolated integration profile was started using
  `docker compose --env-file /dev/null -p acornops-triage-context-20261103 -f
  /private/tmp/acornops-triage-context-20261103/integration.compose.json --profile
  integration up -d --build`. Real stored Insights, authenticated HTTP context
  reads and the actual Engine `OrchestratorClient` passed for both target types.
  Its containers and volumes, and the separate test database/cache containers,
  were removed after validation. Existing local environments were untouched.
- Independent source and deployment reviews found no actionable issue.

## Release

[PR 36](https://github.com/acornops/control-plane/pull/36) merged as
`e8d76107811053f7c386631ad20027d1771c587d`. Both
[candidate CI](https://github.com/acornops/control-plane/actions/runs/41592409720)
and [main CI](https://github.com/acornops/control-plane/actions/runs/41592606551)
passed. [Release .46](https://github.com/acornops/control-plane/actions/runs/41593326075)
passed; OCI provenance matches the tested source. Engine documentation commit
`eab31a8454720e89acf16adcfc8a613f43edc3ce` and its CI passed without an Engine
image change. Existing main-checkout draft edits were preserved.

No route, public schema, database migration, tool permission or runtime dependency
changed. The producer now complies with the consumer's existing contract.
Docs impact: this repair record and mirrored producer/consumer context invariants.
Security impact: retrieved evidence remains untrusted user-priority data; it is
not promoted into the trusted runtime instruction.

## Demo acceptance

Demo-infra main pin commit `37523dab6f752cc2a72b421d3235fa34589cfe9b` triggered
the normal deployment pipeline, which passed as run `41593583159`. Helm advanced
from revision 20 to 21. The deployed .46 digest matches the verified release;
all five applications are ready and other images, settings, credentials,
identities, storage and migration checksums are preserved.

Before rollout, redacted reads of both affected target contexts reproduced
`messages.0.role` literal errors with retrieved Insights. After rollout, both
contexts pass the deployed Engine model and all three transcript compilers:
Kubernetes has three snippets, VM has two, and all roles are user/assistant.
Conversation text was replaced inside Control Plane before serialization.
Public endpoint verification also passed. No live provider completion was
submitted during acceptance; the actual HTTP retrieval/consumer path was
exercised with stored fixtures in the isolated integration stack.

Historical failure messages remain in conversation history. Retrying triage uses
the corrected producer; no console or agent upgrade is needed for this repair.
