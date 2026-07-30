# Agent Emoji Identity

Status: Complete

## Goal

Persist one user-selected emoji on every Agent definition and expose it through
the public Agent create, update, list, detail, duplicate, and version flows.

## Constraints

- Keep request compatibility by making `avatarEmoji` optional on mutations.
- Give existing definitions a stable neutral fallback.
- Accept exactly one emoji grapheme and reject arbitrary text.
- Preserve the emoji through duplication and version restore.
- Keep capability, runtime, and authorization behavior unchanged.

## Decision Log

- The producer field is `avatarEmoji`.
- Stored definitions always have a value; the default is `🤖`.
- Starter Agent templates provide role-specific values.
- The management console owns presentation and emoji selection.

## Validation Log

- `npm run typecheck` passed.
- `npm run migrations:check` passed.
- `npm run contracts:check` passed.
- `npm run openapi:check` passed.
- `npm run style:check` passed.
- `npm run harness:check` passed.
- `NODE_ENV=test node --import tsx --test test/agent-avatar-emoji.test.ts`
  passed.
- The database-backed controller test coverage was added but not executed
  locally because neither `CONTROL_PLANE_TEST_DATABASE_URL` nor `DATABASE_URL`
  points to an isolated test database.
- `npm run build` reached TypeScript emission but could not overwrite existing
  `dist/` artifacts owned by `nobody:nogroup`; the no-emit typecheck passed.

## Completion Criteria

- Migration, repository, controller, and OpenAPI paths round-trip the field.
- Controller tests cover create, update, duplicate, version restore, and invalid
  values.
- Contract manifests agree with the management-console consumer.
