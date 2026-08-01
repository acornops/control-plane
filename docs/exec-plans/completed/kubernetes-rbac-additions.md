# Kubernetes RBAC Additions

## Goal

Add an audited platform setting for named Kubernetes RBAC bundles and snapshot
selected bundles when a cluster is registered.

## Boundaries

- The control plane validates canonical structured values; YAML is an admin-console
  authoring format only.
- Users receive bundle keys, names, and descriptions, never rule internals.
- Registration persists the resolved rules, source version, and content hash.
- Admin setting changes never mutate existing cluster snapshots.
- Agent-key rotation reuses the stored snapshot.
- Helm policy supplies an optional baseline catalog; the durable admin value is
  an additive overlay of upserts and disabled deployment keys.
- The effective catalog is bounded to 25 profiles and can be made deployment-only
  with `runtimeEditable: false`.
- Profiles support `get`, `list`, `watch`, `create`, `patch`, and `delete`;
  onboarding filters write verbs when agent access is read-only.

## Contract and persistence

- Extend `/admin/v1/system/settings` with `kubernetes_rbac_additions`.
- Add a workspace-authorized Kubernetes additions discovery endpoint.
- Extend cluster registration with `rbacAdditionKeys`.
- Add additive JSONB snapshot columns with empty defaults for existing clusters.

## Validation

- Cover setting validation and audit, authorization, selection errors, immutable
  snapshots, command generation, migration safety, OpenAPI, and mirrored contracts.
- Run typecheck, tests, contracts, harness checks, and repository validation.

## Result

Complete. Thirty-five focused RBAC, catalog, installation, platform-setting, and
immutable rotation tests pass. Typecheck, style, migration static checks, authorization,
membership, run-event durability, contracts, OpenAPI, harness, and build pass.
The full suite remains dependent on existing local database/runtime fixtures and
was not used as feature evidence.

A local-runtime follow-up added the platform-setting migration after PostgreSQL rejected the new
setting key under the pre-existing exact-key constraint. The forward migration
preserves applied migration checksums and extends only the allowlist with
`kubernetes_rbac_additions`. It was applied through `control-plane-init`; an
upgrade-path CNPG insert/rollback, greenfield SQL migration introspection, 18
focused persistence/policy tests, typecheck, and style checks pass. After
rebasing over upstream migrations 006 and 007, the RBAC migrations are numbered
008 and 009 without changing already-applied history.

Resource plurals are unique within each profile because AgentK tool calls resolve
an approved resource by profile key and plural. This prevents API-group or
version variants from becoming ambiguous at execution time.
