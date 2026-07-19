import { config } from '../config.js';
import { DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_WORKSPACE_ID } from '../constants/dev-defaults.js';
import { logger } from '../logger.js';
import {
  createTargetMcpServer,
  listTargetMcpServers,
  updateTargetMcpServer
} from './mcp-registry-client.js';
import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';

export async function ensureDevelopmentMcpSeed(): Promise<void> {
  if (!config.SEED_DEVELOPMENT_DATA) {
    return;
  }

  try {
    const servers = await listTargetMcpServers(DEVELOPMENT_WORKSPACE_ID, DEVELOPMENT_CLUSTER_ID, KUBERNETES_TARGET_TYPE);
    const existing = servers.find(
      (server) => server.server_name === config.BUILTIN_TARGET_MCP_SERVER_NAME || server.server_url === config.BUILTIN_TARGET_MCP_SERVER_URL
    );

    if (!existing) {
      await createTargetMcpServer({
        workspaceId: DEVELOPMENT_WORKSPACE_ID,
        targetId: DEVELOPMENT_CLUSTER_ID,
        targetType: KUBERNETES_TARGET_TYPE,
        name: config.BUILTIN_TARGET_MCP_SERVER_NAME,
        url: config.BUILTIN_TARGET_MCP_SERVER_URL,
        enabled: true,
        auth: { type: 'none' }
      });
      return;
    }

    await updateTargetMcpServer({
      workspaceId: DEVELOPMENT_WORKSPACE_ID,
      targetId: DEVELOPMENT_CLUSTER_ID,
      targetType: KUBERNETES_TARGET_TYPE,
      serverId: existing.id,
      name: config.BUILTIN_TARGET_MCP_SERVER_NAME,
      enabled: true,
      auth: { type: 'none' }
    });
  } catch (err) {
    logger.warn({ err }, 'Failed ensuring development MCP seed configuration');
  }
}
