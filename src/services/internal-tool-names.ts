import { isWorkspaceNativeToolName } from './workspace-native-tools.js';

export const ACORNOPS_INTERNAL_TOOL_PREFIX = '_acornops_';
export const INTERNAL_MODEL_ONLY_TOOLS = new Set(['_acornops_load_skill']);

export function isReservedInternalToolName(toolName: string): boolean {
  return INTERNAL_MODEL_ONLY_TOOLS.has(toolName)
    || toolName.startsWith(ACORNOPS_INTERNAL_TOOL_PREFIX)
    || isWorkspaceNativeToolName(toolName);
}
