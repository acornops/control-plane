# OpenAI native-tool availability

## Goal

Keep target Web Search preferences intact while preventing ordinary assistant
runs from requesting the OpenAI native-tool contract when the deployment uses
the Chat Completions surface.

## Scope

- Treat configured and effective Web Search state separately.
- Reuse the deployment-owned OpenAI API-surface value in control-plane.
- Omit unavailable Web Search capability during target-run resolution.
- Expose a bounded unavailable reason for the management console.
- Preserve llm-gateway's existing rejection as defense in depth.

## Validation

- Control-plane type checking, focused target-tool controller and resolver
  tests, and contract checks passed.
- Management-console linting, focused UI and i18n tests, the complete unit
  suite, and design snapshots passed.
- Deployment validation, including Compose, Helm, release-matrix, and
  cross-repository platform contract checks, passed.

## Outcome

Web Search remains a saved target preference while its effective availability
is derived from the selected provider and deployment API surface. When OpenAI
uses Chat Completions, ordinary target assistant runs omit Web Search and the
management console explains why without silently clearing the preference.
