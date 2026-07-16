# Chat Runtime Selection

## Goal

Expose each chat session's latest accepted run runtime and return the resolved
runtime from message submission so browser clients can restore model and
reasoning choices without creating a second mutable preference.

## Constraints and Decisions

- The immutable run snapshot remains the durable source of truth.
- Session responses derive `lastRuntimeSelection` from the newest run ordered by
  `requested_at DESC, id DESC`.
- Message acceptance returns the stored run selection, including idempotent
  retries.
- Empty sessions omit the additive runtime field.
- The change remains compatible with older clients.
- The management console is the affected consumer and its mirrored contract
  manifest changes in the coordinated branch.

## Validation Log

- Passed focused repository and controller coverage (20 tests).
- Passed `npm run validate` against an isolated PostgreSQL test database (609
  tests, plus typecheck, style, migration, authz, contract, OpenAPI, harness,
  and build checks).
- Passed `node scripts/harness/check-platform-contracts.mjs` at the workspace
  root.
- Live console integration accepted separate High and Low run selections and
  restored both from session responses after logout/login.
- Cleanup review consolidated accepted-message response mapping into the
  existing session LLM module; migration SQL checks also passed against a clean
  PostgreSQL database.

## Completion Criteria

- Session list/detail and message-accepted contracts expose the runtime.
- Empty sessions remain valid without a runtime.
- OpenAPI, manifests, migration checks, and tests pass.

All completion criteria are satisfied.
