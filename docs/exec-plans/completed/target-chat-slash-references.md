# Target chat slash references

> Archive review — 2026-10-18: Implementation landed (control-plane bc14ca2, execution-engine aad43f3, management-console 36751f5). The original validation checklist below is historical, not a claim that those commands were rerun during this cleanup.
> Original scope, checklists, and validation below are historical; this is not a new runtime or rollout validation report.

## Goal

Validate and freeze exact tool and skill references supplied with target-chat
messages, without widening the run capability ceiling.

## Contract boundaries

- `POST /api/v1/sessions/{sessionId}/messages` accepts an optional bounded
  `references` array containing `{ kind: tool|skill, id }` entries.
- Resolve every entry against the authenticated session target and the same
  allowed capability snapshot used for the requested tool-access mode.
- Persist server-qualified tool identity and target skill identity on the run.
- Reject duplicates, disabled capabilities, wrong-target IDs, and stale
  references with a bounded `ASSISTANT_REFERENCE_INVALID` response.
- Bootstrap exposes referenced tool aliases and referenced frozen skill refs as
  additive fields. Existing allowed tools, skill catalog, JWT claims, readiness,
  write confirmation, and approval behavior remain unchanged.
- Audit stable reference IDs and kinds only; never log prompt bodies, arguments,
  credentials, schemas, or skill contents.

## Compatibility and rollout

- The request field is optional and existing clients remain compatible.
- The execution snapshot additions are optional and older snapshots remain
  valid.
- Deploy the database migration and control plane before enabling the composer;
  deploy execution-engine support before the management-console feature.

## Validation

- Schema bounds and duplicate tests.
- Tool and skill resolution, wrong-target, disabled, write-mode, idempotency,
  persistence, bootstrap, and audit tests.
- `npm run validate`, contract checks, and workspace platform contract checks.
