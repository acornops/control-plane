export const WORKSPACE_DEFAULT_KINDS = ['mcp_server', 'skill'] as const;
export type WorkspaceDefaultKind = typeof WORKSPACE_DEFAULT_KINDS[number];

export const WORKSPACE_DEFAULT_AVAILABILITY = ['agents', 'kubernetes', 'virtual_machines'] as const;
export type WorkspaceDefaultAvailability = typeof WORKSPACE_DEFAULT_AVAILABILITY[number];

export interface WorkspaceDefaultMcpSource {
  type: 'https';
  endpoint: string;
}

export interface WorkspaceDefaultManualSkillSource {
  type: 'manual';
}

export interface WorkspaceDefaultGitSkillSource {
  type: 'git';
  provider: 'github' | 'gitlab';
  repoUrl: string;
  ref: string;
  subpath?: string;
  commitSha: string;
}

export type WorkspaceDefaultSkillSource =
  | WorkspaceDefaultManualSkillSource
  | WorkspaceDefaultGitSkillSource;

export interface WorkspaceDefaultSkillFile {
  path: string;
  content: string;
  contentDigest: string;
  sizeBytes: number;
}

export interface WorkspaceDefault {
  id: string;
  kind: WorkspaceDefaultKind;
  name: string;
  description: string;
  availableIn: WorkspaceDefaultAvailability[];
  enabled: boolean;
  source: WorkspaceDefaultMcpSource | WorkspaceDefaultSkillSource;
  contentDigest?: string;
  files?: WorkspaceDefaultSkillFile[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInitialDefault {
  id: string;
  workspaceId: string;
  kind: WorkspaceDefaultKind;
  name: string;
  description: string;
  availableIn: WorkspaceDefaultAvailability[];
  source: WorkspaceDefaultMcpSource | WorkspaceDefaultSkillSource;
  contentDigest?: string;
  files?: WorkspaceDefaultSkillFile[];
  initializedAt: string;
}

export type CapabilityProvenance = {
  inherited: boolean;
};
