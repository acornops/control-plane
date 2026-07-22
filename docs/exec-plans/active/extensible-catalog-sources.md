# Extensible catalog sources

## System-provided automation correction

- Present template-origin Agents and workflows as system provided rather than as user-owned templates.
- Preserve workspace availability, supported external bindings, and deletion while requiring duplication before definition edits or version restore.
- Keep the template-origin Manager internal to compilation and execution; omit it from public Agent APIs and direct user operations.
- Enforce the boundary in the control plane and mirror it in management-console actions and contract manifests.

## Goal

Expose secret-free, permission-checked catalog APIs while preserving capability
ownership for workspace Agents and target-local generic agents.

## Boundaries

- `manage_catalog_sources` controls source administration.
- Adding MCP servers or tools requires both `manage_agents` and `manage_mcp`;
  adding skills requires `manage_agents` and `manage_skills`.
- `manage_agents` alone may remove an Agent capability. Tool review still
  requires `manage_mcp`.
- Agent installations and reviewed `McpToolRef { serverId, toolName }` grants
  are snapshotted with every run. Name-only remote tool authorization is invalid.
- Kubernetes clusters and VMs retain their own MCP servers, skills, and tools;
  these belong to each target's generic agent and stay on target-scoped routes.
- Workflows may only intersect the selected Agent snapshot. Empty restrictions
  inherit its ceiling; non-empty restrictions subtract from it.
- Target adapters remain authoritative for native Kubernetes and VM tools,
  credentials, inventory, and operational context. Agent constraints use
  authoritative target IDs and target types.
- Interactive runs and workflow schedules act as their authenticated user.
  Schedules cannot delegate to service identities and fail closed when their
  creator loses current workspace authorization. Other service-identity APIs
  and internal trigger uses remain intact.
- Legacy workspace workflow MCP administration remains retired. Existing target
  MCP and skill routes remain supported because their resources are target-owned,
  not workspace-Agent installations.

## Target boundary

| Concept | Shared target model | Kubernetes-specific | VM-specific | Notes |
| --- | --- | --- | --- | --- |
| Target identity and constraints | authoritative ID/type | cluster ID | VM ID | Agent constraints never use display names. |
| Native tools | capability contract | AgentK tools | AgentV tools | Owned and routed by the target adapter. |
| Third-party MCP and skills | target-scoped interface | cluster agent | VM agent | Target-local capabilities stay with the target; workspace Agent installations remain separate. |
| Credentials and inventory | adapter interface | kube/AgentK | VM/AgentV | Never copied onto an Agent or workflow. |
| Workflow selection | selected Agent snapshot | subtractive only | subtractive only | Unsupported capability fails readiness explicitly. |

## Validation

- Split RBAC, Agent/target isolation, independent imports and reimports,
  server-derived target types, destination-bound credential connections,
  immutable provenance,
  duplicate tool refs, workflow subtraction, principals, permission modes,
  readiness, active/inactive creator schedule migration, additive-migration
  preservation, and secret-absence tests.
- `npm run validate` and platform contract checks.

## Development seed boundary

- Keep the optional development target fixture limited to the development user,
  workspace, Kubernetes target, target settings, and optional AgentK key.
- Default `SEED_DEVELOPMENT_DATA` to false in configuration, standalone env,
  and local Compose. Preserve explicit development opt-in and the production
  rejection of any enabled seed.
- Provision the same one-time starter automation for every workspace, including
  the development fixture workspace. Keep this universal provisioning separate
  from `SEED_DEVELOPMENT_DATA`; do not add VM, provider credential, MCP,
  invitation, or skill fixture records.

## Development seed validation evidence

- Focused configuration and repository seeder tests pass, including default-off,
  explicit development opt-in, production rejection, narrow seed content, and
  idempotent inserts. Type checking passes.
- The canonical suite ran against an isolated PostgreSQL database with all 15
  migrations applied and completed 605 of 606 tests. The remaining pre-existing
  workspace-deletion regression returns 502 because the dirty worktree now calls
  `cleanupMcpConnections` without extending that test's HTTP mock; it is outside
  the development-seed path changed here.
- Contract checks pass. The repository harness is independently blocked by the
  pre-existing dirty `target-tool-controller.ts` reaching 576 lines against its
  550-line budget; the fixture/seed changes do not touch that controller.

## MCP credential and schedule readiness closure

- Treat missing Web Search and Target Insights setting rows as their documented
  default-enabled state while preserving explicit disablement and fail-closed
  behavior when settings cannot be read.
- Keep individual MCP credentials user-owned with no cross-user fallback, and
  make service-identity incompatibility explicit in public recovery messages.
- Preflight an enabled workflow schedule against the authenticated schedule
  owner's exact MCP connections before persistence. Revalidate when a paused
  schedule is enabled, while retaining dispatch-time auto-pause as defense in
  depth.
- When an Agent MCP server changes from workspace-managed to individual
  credentials, immediately auto-pause every enabled schedule whose workflow
  uses that Agent, preserve prior run history, and audit the configuration
  impact. Dispatch-time readiness remains the fallback for concurrent changes.
- Reuse the same prompt binding, exact workflow scope, and MCP readiness rules
  used by interactive launches and scheduled dispatch.
- Add focused resolver, schedule-controller, and management-console tests, then
  run repository and workspace validation.
