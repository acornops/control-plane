import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import { syncTargetBuiltInTools } from './target-built-in-tool-sync.js';

export async function syncKubernetesClusterBuiltInTools(workspaceId: string, clusterId: string): Promise<void> {
  await syncTargetBuiltInTools(workspaceId, clusterId, KUBERNETES_TARGET_TYPE);
}
