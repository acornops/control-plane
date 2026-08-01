import type { AgentSkillInstallationSnapshot } from '../types/agents.js';
import type { TargetType } from '../types/domain.js';
import type { TargetSkillSummary } from '../types/target-skills.js';
import type {
  CapabilityProvenance,
  WorkspaceDefaultAvailability,
  WorkspaceDefaultSkillSource,
  WorkspaceInitialDefault
} from '../types/workspace-defaults.js';
import {
  getWorkspaceInitialDefault,
  listWorkspaceInitialDefaults
} from '../store/repository-workspace-defaults.js';
import type {
  AgentMcpServerConfig,
  McpServerConfig,
  TargetMcpServerConfig
} from './mcp-registry-client.js';

const INHERITED_ID_PREFIX = 'platform-default:';

export type ProvenancedMcpServerConfig = McpServerConfig & CapabilityProvenance;
export type ProvenancedAgentSkill = AgentSkillInstallationSnapshot & CapabilityProvenance;
export type ProvenancedTargetSkill = TargetSkillSummary & CapabilityProvenance;

export function inheritedWorkspaceDefaultId(id: string): string {
  return `${INHERITED_ID_PREFIX}${id}`;
}

export function workspaceDefaultIdFromInheritedId(id: string): string | null {
  return id.startsWith(INHERITED_ID_PREFIX) ? id.slice(INHERITED_ID_PREFIX.length) || null : null;
}

function localProvenance(): CapabilityProvenance {
  return { inherited: false };
}

function inheritedProvenance(): CapabilityProvenance {
  return { inherited: true };
}

export function availabilityMatches(
  availableIn: WorkspaceDefaultAvailability[],
  destination: 'agents' | TargetType
): boolean {
  if (destination === 'agents') return availableIn.includes('agents');
  if (destination === 'kubernetes') return availableIn.includes('kubernetes');
  return availableIn.includes('virtual_machines');
}

function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function canonicalSkillSource(source: AgentSkillInstallationSnapshot['source'] | TargetSkillSummary['source'] | WorkspaceDefaultSkillSource): string | null {
  const url = 'url' in source ? source.url : 'repoUrl' in source ? source.repoUrl : undefined;
  const commit = 'pinnedCommit' in source ? source.pinnedCommit : 'commitSha' in source ? source.commitSha : undefined;
  const path = 'path' in source ? source.path : 'subpath' in source ? source.subpath : undefined;
  if (!url || !commit) return null;
  return `${canonicalUrl(url)}#${commit.toLowerCase()}:${path || ''}`;
}

async function applicableDefaults(
  workspaceId: string,
  kind: 'mcp_server' | 'skill',
  destination: 'agents' | TargetType
): Promise<WorkspaceInitialDefault[]> {
  const defaults = await listWorkspaceInitialDefaults({
    workspaceId,
    kind,
    includeFiles: kind === 'skill'
  });
  return defaults.filter((item) => availabilityMatches(item.availableIn, destination));
}

export function resolveMcpServerDefaults(
  local: AgentMcpServerConfig[],
  destination: 'agents',
  context: { workspaceId: string; destinationId: string }
): Promise<Array<AgentMcpServerConfig & CapabilityProvenance>>;
export function resolveMcpServerDefaults(
  local: TargetMcpServerConfig[],
  destination: TargetType,
  context: { workspaceId: string; destinationId: string }
): Promise<Array<TargetMcpServerConfig & CapabilityProvenance>>;
export async function resolveMcpServerDefaults(
  local: McpServerConfig[],
  destination: 'agents' | TargetType,
  context: { workspaceId: string; destinationId: string }
): Promise<ProvenancedMcpServerConfig[]> {
  const defaults = await applicableDefaults(context.workspaceId, 'mcp_server', destination);
  const existingUrls = new Set(local.map((server) => canonicalUrl(server.server_url)));
  const inherited = defaults
    .filter((item) => item.source.type === 'https' && !existingUrls.has(canonicalUrl(item.source.endpoint)))
    .map((item): ProvenancedMcpServerConfig => {
      if (item.source.type !== 'https') throw new Error('Unexpected workspace default source');
      return {
        id: inheritedWorkspaceDefaultId(item.id),
        workspace_id: context.workspaceId,
        ...(destination === 'agents'
          ? { agent_id: context.destinationId, scope_type: 'agent' as const }
          : { target_id: context.destinationId, scope_type: 'target' as const }),
        ...(destination === 'agents' ? {} : { target_type: destination }),
        server_name: item.name,
        server_url: item.source.endpoint,
        enabled: false,
        auth_type: 'none',
        credential_mode: 'none',
        public_headers: {},
        connection_status: 'unknown',
        tools: [],
        provenance_type: 'manual',
        revision: 1,
        ...inheritedProvenance()
      };
    });
  return [
    ...local.map((server) => ({ ...server, ...localProvenance() })),
    ...inherited
  ].sort((left, right) => left.server_name.localeCompare(right.server_name));
}

export async function resolveAgentSkillDefaults(
  local: AgentSkillInstallationSnapshot[],
  context: { workspaceId: string; agentId: string }
): Promise<ProvenancedAgentSkill[]> {
  const defaults = await applicableDefaults(context.workspaceId, 'skill', 'agents');
  const existing = new Set(local.map((skill) => canonicalSkillSource(skill.source)).filter(Boolean));
  const existingDigests = new Set(local.map((skill) => skill.contentDigest).filter(Boolean));
  const inherited = defaults
    .filter((item) => item.source.type === 'git'
      ? !existing.has(canonicalSkillSource(item.source))
      : !item.contentDigest || !existingDigests.has(item.contentDigest))
    .map((item): ProvenancedAgentSkill => ({
      id: inheritedWorkspaceDefaultId(item.id),
      name: item.name,
      description: item.description,
      enabled: false,
      revision: 1,
      contentDigest: item.contentDigest || '',
      source: item.source.type === 'git'
        ? {
            type: 'git',
            provider: item.source.provider,
            url: item.source.repoUrl,
            ref: item.source.ref,
            path: item.source.subpath,
            pinnedCommit: item.source.commitSha
          }
        : { type: 'manual' },
      files: (item.files || []).map((file) => ({
        path: file.path,
        content: file.content,
        contentDigest: file.contentDigest
      })),
      ...inheritedProvenance()
    }));
  return [
    ...local.map((skill) => ({ ...skill, ...localProvenance() })),
    ...inherited
  ].sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveTargetSkillDefaults(
  local: TargetSkillSummary[],
  targetType: TargetType,
  context: { workspaceId: string; targetId: string }
): Promise<ProvenancedTargetSkill[]> {
  const defaults = await applicableDefaults(context.workspaceId, 'skill', targetType);
  const existing = new Set(local.map((skill) => canonicalSkillSource(skill.source)).filter(Boolean));
  const existingManualDefinitions = new Set(local
    .filter((skill) => skill.source.type === 'manual')
    .map((skill) => `${skill.name}\u0000${skill.description}`));
  const inherited = defaults
    .filter((item) => item.source.type === 'git'
      ? !existing.has(canonicalSkillSource(item.source))
      : !existingManualDefinitions.has(`${item.name}\u0000${item.description}`))
    .map((item): ProvenancedTargetSkill => ({
      id: inheritedWorkspaceDefaultId(item.id),
      workspaceId: context.workspaceId,
      targetId: context.targetId,
      targetType,
      ...(targetType === 'kubernetes' ? { clusterId: context.targetId } : {}),
      name: item.name,
      description: item.description,
      enabled: false,
      validationStatus: 'valid',
      validationErrors: [],
      bundleStats: {
        fileCount: item.files?.length || 0,
        totalBytes: item.files?.reduce((sum, file) => sum + file.sizeBytes, 0) || 0
      },
      source: item.source.type === 'git' ? {
        type: 'git_import',
        provider: item.source.provider,
        repoUrl: item.source.repoUrl,
        ref: item.source.ref,
        subpath: item.source.subpath,
        commitSha: item.source.commitSha,
        syncStatus: 'current'
      } : { type: 'manual', syncStatus: 'not_applicable' },
      createdAt: item.initializedAt,
      updatedAt: item.initializedAt,
      ...inheritedProvenance()
    }));
  return [
    ...local.map((skill) => ({ ...skill, ...localProvenance() })),
    ...inherited
  ].sort((left, right) => left.name.localeCompare(right.name));
}

export async function getInheritedWorkspaceDefault(
  workspaceId: string,
  inheritedId: string,
  kind: 'mcp_server' | 'skill',
  destination: 'agents' | TargetType
): Promise<WorkspaceInitialDefault | null> {
  const id = workspaceDefaultIdFromInheritedId(inheritedId);
  if (!id) return null;
  const item = await getWorkspaceInitialDefault(workspaceId, id, true);
  return item?.kind === kind && availabilityMatches(item.availableIn, destination) ? item : null;
}
