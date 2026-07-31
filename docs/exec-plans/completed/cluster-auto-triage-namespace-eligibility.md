# Cluster Auto-Triage Namespace Eligibility

## Goal

Allow Kubernetes target administrators to choose which observed namespaces may
trigger automatic investigations without changing virtual-machine behavior or
the target's existing AgentK collection and tool-access ceiling.

## Scope

- Persist revisioned namespace include and exclude lists on target auto-triage
  settings.
- Keep empty lists equivalent to all observed namespaces.
- Keep cluster-scoped issues eligible by default, with an explicit setting to
  exclude them.
- Apply one eligibility policy to new issue lifecycles, explicit current-issue
  queueing, manual starts, retries, eligible counts, and worker revalidation.
- Expose the settings only for Kubernetes targets.
- Do not add per-run namespace authorization or modify AgentK.

## Validation

- Add focused policy, controller, persistence, queue, and worker regressions.
- Run control-plane type, contract, migration, OpenAPI, harness, and validation
  gates.

## Status

Completed. Namespace eligibility is persisted, enforced across every automatic
investigation entry point, documented in the public contract, and covered by
policy and PostgreSQL regressions. Database constraints reject malformed
namespace values, and jobs record the settings revision actually pinned to a
created run.
