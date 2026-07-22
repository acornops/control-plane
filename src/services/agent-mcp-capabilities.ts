import type { McpServerConfig } from './mcp-registry-client.js';
import { listAgentMcpServers } from './mcp-registry-client.js';
import { updateAgentMcpCapabilitySnapshot } from '../store/repository-agents.js';
import type { AgentMcpInstallationSnapshot } from '../types/agents.js';

export function toAgentMcpServer(server: McpServerConfig) {
  return {
    id: server.id,
    name: server.server_name,
    url: server.server_url,
    type: 'mcp' as const,
    enabled: server.enabled,
    isSystem: false,
    canDelete: true,
    canEditConnection: true,
    canToggle: true,
    authType: server.auth_type,
    credentialMode: server.credential_mode,
    authHeaderName: server.auth_header_name || undefined,
    authHeaderPrefix: server.auth_header_prefix || undefined,
    agentId: server.agent_id || undefined,
    revision: server.revision || 1,
    targetConstraints: {
      targetTypes: server.target_constraints?.target_types || [],
      targetIds: server.target_constraints?.target_ids || []
    },
    provenance: server.catalog_source_id
      && server.catalog_artifact_name
      && server.catalog_version
      && server.catalog_digest
      && server.catalog_imported_at
      ? {
          sourceId: server.catalog_source_id,
          artifactName: server.catalog_artifact_name,
          version: server.catalog_version,
          digest: server.catalog_digest,
          importedAt: server.catalog_imported_at
        }
      : undefined,
    endpointConfiguration: server.endpoint_configuration || {},
    integrationProfileId: server.integration_profile_id || undefined,
    integrationProfileVersion: server.integration_profile_version || undefined,
    publicHeaders: server.public_headers ?? {},
    connectionStatus: server.connection_status || 'unknown',
    lastDiscoveryAt: server.last_discovery_at ?? null,
    lastDiscoveryError: server.last_discovery_error ?? null,
    tools: server.tools.map((tool) => ({
      name: tool.name,
      serverId: tool.server_id,
      alias: tool.model_alias,
      description: tool.description,
      inputSchema: tool.input_schema,
      outputSchema: tool.output_schema,
      capability: tool.capability || 'write',
      enabled: tool.enabled,
      reviewState: tool.review_state || 'pending',
      riskLevel: tool.risk_level || 'high_risk',
      autoAllowed: tool.auto_allowed === true
    }))
  };
}

export async function syncAgentMcpCapabilitySnapshot(
  workspaceId: string,
  agentId: string,
  updatedBy: string
) {
  const servers = await listAgentMcpServers(workspaceId, agentId);
  const installations: AgentMcpInstallationSnapshot[] = servers.map((server) => {
    const mapped = toAgentMcpServer(server);
    return {
      id: mapped.id,
      name: mapped.name,
      url: mapped.url,
      enabled: mapped.enabled,
      credentialMode: mapped.credentialMode,
      revision: mapped.revision,
      targetConstraints: mapped.targetConstraints,
      provenance: mapped.provenance,
      tools: mapped.tools.map((tool) => ({
        serverId: tool.serverId,
        toolName: tool.name,
        alias: tool.alias,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        capability: tool.capability,
        enabled: tool.enabled,
        reviewState: tool.reviewState,
        riskLevel: tool.riskLevel,
        autoAllowed: tool.autoAllowed
      }))
    };
  });
  const mcpTools = installations.flatMap((installation) => installation.tools
    .filter((tool) => installation.enabled && tool.enabled && tool.reviewState === 'approved')
    .map((tool) => ({ serverId: tool.serverId, toolName: tool.toolName })));
  const agent = await updateAgentMcpCapabilitySnapshot(workspaceId, agentId, {
    mcpServers: installations.map((installation) => installation.id),
    mcpTools,
    mcpInstallations: installations
  }, updatedBy);
  return { agent, servers: servers.map(toAgentMcpServer) };
}
