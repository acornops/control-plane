# Runtime validation security

## Release integration — 2026-10-26

Implementation and independent review are complete. The user subsequently
authorized main integration and a demo release. The original implementation
record below is historical; publication and deployment acceptance are tracked
in the deployment repository's security-maintenance-release plan. Remaining
production gates are not cleared by this source qualification.

Status: implemented and independently reviewed on `fix/runtime-validation-security`;
uncommitted and unpublished. No findings remain in this focused migration.

## Scope

Qualify Zod 4.6.7 and Nodemailer 10.1.4. Preserve supported request defaults,
optional fields, authorization, top-level error contracts, and SMTP configuration.
No migrations, UI changes, release, or deployment are included.

## Work and checks

- Add request-boundary regressions for bounded collection validation and defaults.
- Migrate only incompatible Zod APIs and declarations; audit unconstrained inputs.
- Exercise the real mail transport against local SMTP for delivery, rejection,
  and required TLS. Remove obsolete declarations if the new package owns them.
- Run the full validation command, isolated SQL migration checks, platform
  contracts, and runtime audit; obtain independent review before handoff.

## Coordination

AgentK and AgentV qualify the same Zod patch and their tool schema converters.
Deployment owns the production audit. No external contract change is intended.

## Validation evidence

- Baseline: 1,340 tests passed. Final combined dependency suite: 1,354 tests
  passed, including actual collection traversal regressions and local SMTP.
- Full `npm run validate` passed types, style, authz, membership, durability,
  contracts, OpenAPI, harness, static migrations, and build checks against
  isolated Postgres and Redis. Separate SQL upgrade checks also passed using
  `CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL`; their temporary schema was removed.
- Node 24.2.0 was the main runtime. A verified temporary Node 22.23.4 runtime
  passed 32 validation/email/auth compatibility tests. The machine's misleading
  `node@22` symlink points to Node 24 and was not changed or counted as Node 22.
- `npm audit --omit=dev --json`: zero runtime advisories. Lockfile changes are
  limited to Zod, Nodemailer, removal of obsolete `@types/nodemailer`, and the
  resulting dev-only classification of Node/Undici type packages.
- Both agents passed complete validation and loopback protocol tests; 17 tool
  schemas passed real downstream sanitizer/provider-renderer smoke checks.
- Independent final review found no Critical, Important, or Minor issues and
  reran all 10 validation and 4 real SMTP regressions successfully.
- No live SMTP provider, paid model, production database, or real VM was used.
  Both task-owned disposable containers were stopped and auto-removed after
  verification, discarding only synthetic test data. Existing local/demo
  services were untouched. Logs remain under
  `/tmp/acornops-validation-security-y4rx7q`.

## Collection exposure review

Zod 4's patch rejects arrays over a declared upper bound before validating their
elements. It does not impose a general item, nesting, record-key, or error budget.
The public/internal HTTP parsers retain their 4 MiB byte limit, which is not an
item-count defense. No new business limits were introduced by this migration.

| Entry point | Existing boundary and remaining work |
| --- | --- |
| VM log/restart lists, skill files, target access, external grants, namespace lists, RBAC profiles/resources/verbs, additional model IDs, insight tags/checkpoint patches, message references, output artifacts | Existing array maxima benefit from early rejection. Tests cover VM, skills, nested RBAC, and both AgentK write-array forms. |
| Webhook event types | Requires a user, but schema validation precedes workspace mutation authorization. No item maximum; repeated invalid values can still amplify errors. Highest-priority follow-up: define early cardinality/validation budgets and authorize before expensive validation. |
| Workflow agent IDs and tags | Workspace capability checked before parsing, but no item maximum. Define product limits before tightening the authoring contract. |
| Platform model lists, reasoning choices, sign-in methods | Platform admin scope precedes setting parsing. Some arrays have no maximum; finite enums or deployment model catalogs can inform limits, with duplicate behavior considered. |
| Run-event batches and omission metadata | Service token and execution access precede parsing. Events have no batch maximum; omissions accept arbitrary entries. Bound the producer/consumer batch contract together. |
| MCP headers/configuration/arguments, insight metadata, event payloads, approval continuation, dependency state | Open records retain their existing value validation and access controls. Record counts/nesting need separate schema-aware budgets; arbitrary tool JSON must not be silently truncated. |
| Deployment JSON: models, roles, policy lists | Operator-controlled startup inputs; several arrays remain unbounded. Guard configuration mistakes independently of HTTP admission. |

The remaining public collection exposure is not resolved by a zero-advisory npm
audit. It stays in the production audit; endpoint limits require a focused
follow-up rather than arbitrary compatibility-breaking caps in this dependency
qualification.

## Compatibility decisions

- Use parsed defaults (`prefault`) for nested deployment policy/role objects.
- Remove the create-only status default from partial insight updates.
- Preserve legacy omission of arbitrary approval results and setting values;
  setting-specific validation still rejects invalid settings. Artifact results
  and completed tool-event results remain mandatory.
- Stable API/tool error codes and error envelopes remain; Zod-generated detail
  wording changes. Zod 4 integer validation rejects unsafe integers; UUID and
  timestamp validation is stricter for malformed values. Valid UUIDs, timestamps,
  documented counts, defaults, and direct-registration flows remain covered.
