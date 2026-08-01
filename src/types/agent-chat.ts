import type { WorkspaceCapability } from '../auth/authorization.js';
import type { McpToolRef, RunPermissionMode, RunPrincipalRef } from './agents.js';
import type { WorkspaceAuditOperation } from './domain.js';
import type { PromptResourceBinding } from './prompt-resources.js';
import type { CapabilityAccessMode, CapabilityRestrictionMode } from './capability-access.js';

export interface CompiledAgentChatAccessScope {
  agentId: string;
  workspaceId: string;
  actor: { userId: string; role: string };
  mode: CapabilityAccessMode;
  semanticCapabilityIds: string[];
  capabilityRestrictionMode: CapabilityRestrictionMode;
  requiredPermissions: WorkspaceCapability[];
  grantedCapabilities: WorkspaceCapability[];
  mcpServers: string[];
  mcpTools: McpToolRef[];
  tools: string[];
  toolOperations: Record<string, WorkspaceAuditOperation>;
  nativeToolConfigs: Record<string, Record<string, unknown>>;
  enabledSkills: string[];
  contextGrants: string[];
  approvalGates: string[];
  permissionMode: RunPermissionMode;
  principal: RunPrincipalRef;
  resourceBindings: PromptResourceBinding[];
  promptDigest?: string;
  bindingDigest?: string;
  resourceResolutionPhase: 'run_exact';
}
