import { config } from '../config.js';
import { repo } from '../store/repository.js';
import { isWindowsReadTool } from '../types/virtual-machine-platform.js';
import { AgentToolCallError, type AgentToolDefinition } from '../agent/types.js';

export async function filterVirtualMachineTools(targetId: string, tools: AgentToolDefinition[]): Promise<AgentToolDefinition[]> {
  const vm = await repo.getVirtualMachine(targetId);
  if (!vm) {
    const target = await repo.getTargetById(targetId);
    if (target?.targetType === 'kubernetes') return tools;
    throw missingVirtualMachineError();
  }
  if (vm.osFamily !== 'windows') return tools;
  if (!config.AGENTV_WINDOWS_ENABLED) return [];
  return tools.filter((tool) => isWindowsReadTool(tool.name, tool.capability));
}

export async function assertVirtualMachineRpcAllowed(targetId: string, method: string, params: Record<string, unknown>): Promise<void> {
  if (method !== 'tools/call' && method !== 'tools/list') return;
  const vm = await repo.getVirtualMachine(targetId);
  if (!vm) throw missingVirtualMachineError();
  if (method === 'tools/list') return;
  if (vm.osFamily === 'windows' && (!config.AGENTV_WINDOWS_ENABLED || !isWindowsReadTool(params.name, 'read'))) {
    throw new AgentToolCallError('Windows AgentV permits only reviewed read tools while rollout is enabled', -32601, { code: 'FORBIDDEN', outcome: 'not_started' });
  }
}

function missingVirtualMachineError(): AgentToolCallError {
  return new AgentToolCallError('Virtual machine target no longer exists', -32601, { code: 'NOT_FOUND', outcome: 'not_started' });
}
