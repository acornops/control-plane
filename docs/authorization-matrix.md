# Server-Side Authorization Matrix

The control plane is authoritative for workspace roles and capabilities. Deployments configure supported role templates once, and every workspace inherits that deployment-supported role template catalog. Management console controls may hide unavailable actions, but API handlers must enforce this matrix for every workspace-scoped mutation.

API enforcement for workspace-scoped routes goes through centralized workspace authorization helpers in `src/auth/workspace-authorization.ts`. Controllers should ask for workspace read access, a named workspace capability, target access, or Kubernetes cluster access through that layer instead of reading repository membership or role state directly. For session-cookie authentication, effective permissions are resolved from configured role template capabilities. The built-in templates below are the defaults; deployments may disable non-owner built-ins and add custom role templates with supported capability ids. Future PAT support should narrow those effective permissions in the centralized helper layer, not in individual controllers.

Capability ids: `read_workspace_data`, `read_members`, `read_audit_log`, `delete_workspace`, `manage_members`, `manage_targets`, `manage_mcp`, `manage_tools`, `manage_skills`, `manage_ai_settings`, `manage_agent_keys`, `manage_webhooks`, `create_sessions`, `create_read_only_runs`, `create_read_write_runs`, `read_tarquery_logs`, `cancel_runs`, `delete_sessions`.

## Auth Layering

The intended request flow is `credential -> identity -> workspace authorization -> effective permissions`. Today the only user credential is a session cookie, `requireUser` converts it into `req.auth`, and workspace authorization maps the authenticated user role to effective permissions. Future PAT or OIDC access-token support should add credential variants and permission narrowing in `src/auth/workspace-authorization.ts`; controllers must continue to consume `req.auth` plus centralized workspace authorization helpers.

| Capability | Owner | Admin | Operator | Viewer | Auditor |
| --- | --- | --- | --- | --- | --- |
| List and view workspace shell | Yes | Yes | Yes | Yes | Yes |
| List and view members | Yes | Yes | Yes | Yes | Yes |
| List and view audit log | Yes | Yes | No | No | Yes |
| List and view targets, Kubernetes clusters, sessions, runs, webhooks, tools, MCP servers | Yes | Yes | Yes | Yes | No |
| Delete workspace | Yes | No | No | No | No |
| Manage workspace members or ownership | Yes | Yes* | No | No | No |
| Register, update, or delete targets and Kubernetes clusters | Yes | Yes | No | No | No |
| Create, update, delete, or test MCP servers | Yes | Yes | No | No | No |
| Toggle cluster tools | Yes | Yes | No | No | No |
| Create, import, update, reimport, delete, enable, or disable target skills | Yes | Yes | No | No | No |
| Manage workspace AI provider settings and credentials | Yes | Yes | No | No | No |
| Rotate agent keys | Yes | Yes | No | No | No |
| Create troubleshooting sessions | Yes | Yes | Yes | No | No |
| Create read-only runs | Yes | Yes | Yes | No | No |
| Read pod logs through `get_resource_logs` | Yes | Yes | Yes | No | No |
| Create read-write runs | Yes | Yes | No | No | No |
| Cancel troubleshooting runs | Yes | Yes | Yes | No | No |
| Delete troubleshooting sessions | Yes | Yes | No | No | No |
| Create, update, delete, or read delivery history for webhooks | Yes | Yes | No | No | No |

## Direct Tool Calls

The public control-plane route for direct agent tool calls is removed. Runtime tool execution must flow through the internal execution path and llm-gateway run-scoped authorization so tool registry filtering, schema enforcement, and run JWT permissions remain in effect.

## Membership Management

Admins can add, update, and remove non-protected members. Only owners can grant, revoke, or remove protected roles. `owner` is always supported, always protected, and every workspace must retain at least one owner; the built-in `auditor` role is protected when enabled. Membership and invitation role keys must exist in the deployment-supported role templates. The control plane must reject unsupported role keys and any member update or removal that would leave a workspace without at least one owner.

## Management Console Contract

`GET /api/v1/workspaces` and `GET /api/v1/workspaces/{workspaceId}` return the server-owned `currentUserRole`, optional `currentUserRoleTemplate`, `permissions`, `clusterCount`, and `memberCount` fields for each workspace summary. Operational counts must follow `permissions.read_workspace_data`; auditor summaries return `clusterCount: 0` and keep `memberCount` for member context. `GET /api/v1/workspaces/{workspaceId}/roles` returns the read-only deployment role template catalog. `GET /api/v1/workspaces/{workspaceId}/members` returns authoritative workspace membership with optional `roleTemplate` metadata. UI code must use those fields and must not duplicate role/capability logic.
