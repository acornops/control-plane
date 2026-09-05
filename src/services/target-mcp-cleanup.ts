import { KUBERNETES_TARGET_TYPE, TargetType, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { teardownMcpDestination } from './mcp-registry-client.js';

export async function cleanupTargetMcpState(
  workspaceId: string,
  targetId: string,
  targetType: TargetType
): Promise<void> {
  await teardownMcpDestination(workspaceId, { kind: 'target', id: targetId, targetType });
}

export async function cleanupKubernetesTargetMcpServers(workspaceId: string, targetId: string): Promise<void> {
  await cleanupTargetMcpState(workspaceId, targetId, KUBERNETES_TARGET_TYPE);
}

export async function cleanupVirtualMachineTargetMcpServers(workspaceId: string, targetId: string): Promise<void> {
  await cleanupTargetMcpState(workspaceId, targetId, VIRTUAL_MACHINE_TARGET_TYPE);
}
