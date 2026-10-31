# HTTP parser log protection implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Reject invalid HTTP bodies without writing their contents to service logs.
**Architecture:** Wrap the existing JSON parser with a shared error boundary. Only parser failures receive a safe status/code/message; unrelated application errors retain their current handler.
**Tech Stack:** Express 5, TypeScript, Pino, Node test runner.
**Spec:** Accepted scope below, approved in the project audit conversation on 2026-11-01.

## Accepted scope and global constraints

- Cover public and internal HTTP listeners; retain the 4 MiB cap, compression support, and exact valid raw bodies used by webhook signatures.
- Log fixed parser-error metadata, never the body, parser exception message, stack, URL, or nested cause.
- Use 400 for malformed requests, 413 for oversized bodies, and 415 for unsupported encoding/charset, preserving the standard error envelope and request ID.
- Do not change unrelated exceptions, authentication, routes, or dependencies.

## Review focus

- Sensitive text in both parser body and exception message must be absent from serialized logs.
- Compressed malformed input must use the same safe boundary.
- Oversized requests must not become retryable server errors.
- Valid JSON bytes must remain available unchanged for webhook signatures.
- Both HTTP listeners must behave identically and remain healthy after failure.

## Task 1: Protect the parser boundary

**Files:** `src/app.ts`, `src/internal-app.ts`, new `src/middleware/json-body-parser.ts`, `test/request-parser-security.test.ts`, `docs/SECURITY.md`.
**Interfaces:** `jsonBodyParser(): RequestHandler` replaces the existing `express.json` middleware; no route changes.

- [x] Add HTTP regression tests capturing serialized Pino output for synthetic secrets, malformed/compressed/oversized bodies and both listeners; verify valid raw bytes with a small Express harness.
- [x] Run `NODE_ENV=test node --import tsx --test test/request-parser-security.test.ts`; expect the secret-disclosure/status assertions to fail before implementation.
- [x] Implement the parser-local safe boundary and replace the two parser registrations.
- [x] Run the targeted tests, then `npm run validate`; expect passing checks, or document independent environment blockers explicitly.
- [x] Update the security invariant, record evidence, and commit only this change as `fix: protect HTTP parser error logs`.

## Validation evidence

`npm run validate`: passed with 1,617 tests. Targeted parser tests: 5 passed. The existing parser test was updated for the intentional 400 response; its secrecy assertion is preserved.

Implementation verified; awaiting integration. No database migration or dependency change.
