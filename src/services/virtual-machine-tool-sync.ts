import { VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { syncTargetBuiltInTools } from './target-built-in-tool-sync.js';

export async function syncVirtualMachineBuiltInTools(workspaceId: string, targetId: string): Promise<void> {
  await syncTargetBuiltInTools(workspaceId, targetId, VIRTUAL_MACHINE_TARGET_TYPE);
}
