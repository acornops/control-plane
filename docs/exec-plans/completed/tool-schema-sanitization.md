# Tool Schema Sanitization

## Goal

Keep provider-bound tool schemas valid when untrusted metadata exceeds the
configured nesting limit, including the structured AgentK `patch_resource`
schema.

## Constraints

- Preserve the existing depth and item-count limits.
- Preserve primitive enum and required-field values at the depth boundary.
- Never emit `null` as a replacement for a JSON Schema node.
- Keep backend tool argument validation authoritative.
- Do not change the AgentK tool contract or public API manifests.

## Decision Log

- Sanitize scalar values before applying the container-depth limit.
- Replace an over-depth object schema with the valid permissive schema `{}` and
  omit an unsupported over-depth container rather than emitting `null`.
- Mirror the boundary behavior in the execution engine's final LLM sanitization
  stage.

## Validation Log

- Targeted tool metadata tests passed.
- `npm run validate` passed with 551 tests.
- The real AgentK `patch_resource` schema retained all seven operations and no
  injected nulls after both sanitization stages.
- A live write-capable Kubernetes assistant run completed with `gpt-5-nano`
  while advertising the corrected schema.
- Workspace cross-repository contract checks passed.

## Completion Criteria

- Deep tool schemas remain valid JSON Schema after control-plane sanitization.
- Nested enum values survive at the depth boundary.
- Regression tests cover deeply nested schema objects, intentional null
  literals, and unsupported future metadata values.
