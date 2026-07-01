import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import {
  deleteTargetMcpServer,
  listTargetMcpServers
} from './mcp-registry-client.js';

export async function cleanupKubernetesTargetMcpServers(workspaceId: string, targetId: string): Promise<void> {
  const servers = await listTargetMcpServers(workspaceId, targetId, KUBERNETES_TARGET_TYPE);
  for (const server of servers) {
    await deleteTargetMcpServer(workspaceId, targetId, KUBERNETES_TARGET_TYPE, server.id);
  }
}
