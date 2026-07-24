import type { McpToolRef } from './agents.js';
import type { TargetType, WorkspaceAuditOperation } from './domain.js';

export type CapabilityMappingReviewState = 'draft' | 'reviewed';
export type CapabilityMappingStatus = 'active' | 'disabled';

export interface CapabilityMappingToolRef extends McpToolRef {
  alias: string;
  operation: WorkspaceAuditOperation;
}

/**
 * A reviewed routing record. Semantic IDs are selection labels only; the
 * resource fields are the authority that is copied into a compiled run scope.
 */
export interface CapabilityRoutingMapping {
  id: string;
  workspaceId: string;
  capabilityId: string;
  version: number;
  agentId: string;
  agentVersion: number;
  status: CapabilityMappingStatus;
  reviewState: CapabilityMappingReviewState;
  priority: number;
  targetTypes: TargetType[];
  targetIds: string[];
  mcpTools: CapabilityMappingToolRef[];
  targetToolRefs: CapabilityMappingToolRef[];
  nativeToolIds: string[];
  skillIds: string[];
  contextGrants: string[];
  createdBy: string;
  reviewedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompiledCapabilityResources {
  capabilityIds: string[];
  mcpTools: CapabilityMappingToolRef[];
  targetToolRefs: CapabilityMappingToolRef[];
  nativeToolIds: string[];
  skillIds: string[];
  contextGrants: string[];
}
