import {
  createWorkspaceMcpServer,
  deleteWorkspaceMcpServer,
  listWorkspaceMcpServers,
  testWorkspaceMcpServerConnection,
  updateWorkspaceMcpServer,
  type McpServerConfig
} from '../services/mcp-registry-client.js';
import type {
  WorkflowMcpServerInput,
  WorkflowMcpServerRecord,
  WorkflowMcpToolRecord
} from './repository-workflows.js';

interface WorkflowMcpRepositoryOverride {
  list(workspaceId: string): Promise<WorkflowMcpServerRecord[]>;
  create(workspaceId: string, input: WorkflowMcpServerInput): Promise<WorkflowMcpServerRecord>;
  update(workspaceId: string, serverId: string, patch: Partial<Omit<WorkflowMcpServerInput, 'createdBy'>>): Promise<WorkflowMcpServerRecord | null>;
  delete(workspaceId: string, serverId: string): Promise<boolean>;
  test(workspaceId: string, serverId: string): Promise<WorkflowMcpServerRecord | null>;
  tools(workspaceId: string, serverId: string): Promise<WorkflowMcpToolRecord[] | null>;
}

let repositoryOverride: WorkflowMcpRepositoryOverride | undefined;

export function configureWorkflowMcpRepositoryForTests(override?: WorkflowMcpRepositoryOverride): void {
  repositoryOverride = override;
}

function mapTool(tool: McpServerConfig['tools'][number]): WorkflowMcpToolRecord {
  return {
    name: tool.name,
    title: tool.description || tool.name,
    capability: tool.capability === 'read' ? 'read' : 'write',
    enabled: tool.enabled
  };
}

function mapServer(server: McpServerConfig): WorkflowMcpServerRecord {
  return {
    id: server.id,
    workspaceId: server.workspace_id,
    scope: 'workspace',
    name: server.server_name,
    url: server.server_url,
    enabled: server.enabled,
    authType: server.auth_type,
    authHeaderName: server.auth_header_name,
    credentialConfigured: Boolean(server.credential_configured),
    publicHeaders: server.public_headers || {},
    status: !server.enabled
      ? 'disabled'
      : server.connection_status === 'ok'
        ? 'connected'
        : server.connection_status === 'error'
          ? 'error'
          : 'not_checked',
    lastCheckedAt: server.last_discovery_at || undefined,
    discoveryError: server.last_discovery_error || undefined,
    tools: server.tools.map(mapTool),
    createdBy: 'gateway',
    createdAt: server.last_discovery_at || new Date(0).toISOString()
  };
}

export async function ensureCanonicalWorkflowMcpServers(_workspaceId: string): Promise<void> {
  // Workspace MCP access is intentionally empty until an administrator configures it.
}

export async function listWorkflowMcpServers(workspaceId: string): Promise<WorkflowMcpServerRecord[]> {
  if (repositoryOverride) return repositoryOverride.list(workspaceId);
  return (await listWorkspaceMcpServers(workspaceId)).map(mapServer);
}

export async function createWorkflowMcpServer(
  workspaceId: string,
  input: WorkflowMcpServerInput
): Promise<WorkflowMcpServerRecord> {
  if (repositoryOverride) return repositoryOverride.create(workspaceId, input);
  const server = await createWorkspaceMcpServer({
    workspaceId,
    name: input.name,
    url: input.url,
    enabled: input.enabled,
    publicHeaders: input.publicHeaders,
    auth: {
      type: input.auth?.type,
      secretValue: input.auth?.credential,
      headerName: input.auth?.headerName
    }
  });
  return mapServer(server);
}

export async function updateWorkflowMcpServer(
  workspaceId: string,
  serverId: string,
  patch: Partial<Omit<WorkflowMcpServerInput, 'createdBy'>>
): Promise<WorkflowMcpServerRecord | null> {
  if (repositoryOverride) return repositoryOverride.update(workspaceId, serverId, patch);
  const server = await updateWorkspaceMcpServer({
    workspaceId,
    serverId,
    name: patch.name,
    enabled: patch.enabled,
    publicHeaders: patch.publicHeaders,
    auth: patch.auth ? {
      type: patch.auth.type,
      secretValue: patch.auth.credential,
      headerName: patch.auth.headerName
    } : undefined
  });
  return mapServer(server);
}

export async function deleteWorkflowMcpServer(workspaceId: string, serverId: string): Promise<boolean> {
  if (repositoryOverride) return repositoryOverride.delete(workspaceId, serverId);
  await deleteWorkspaceMcpServer(workspaceId, serverId);
  return true;
}

export async function testWorkflowMcpServerConnection(
  workspaceId: string,
  serverId: string
): Promise<WorkflowMcpServerRecord | null> {
  if (repositoryOverride) return repositoryOverride.test(workspaceId, serverId);
  await testWorkspaceMcpServerConnection(workspaceId, serverId);
  const server = (await listWorkspaceMcpServers(workspaceId)).find((item) => item.id === serverId);
  return server ? mapServer(server) : null;
}

export async function listWorkflowMcpServerTools(
  workspaceId: string,
  serverId: string
): Promise<WorkflowMcpToolRecord[] | null> {
  if (repositoryOverride) return repositoryOverride.tools(workspaceId, serverId);
  const server = (await listWorkspaceMcpServers(workspaceId)).find((item) => item.id === serverId);
  return server ? server.tools.map(mapTool) : null;
}
