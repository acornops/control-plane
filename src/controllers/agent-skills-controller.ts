import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { getTargetSkillBundleStorageLimitErrors, normalizeTargetSkillBundle } from '../services/target-skills.js';
import { syncAgentSkillCapabilitySnapshot } from '../services/agent-skill-capabilities.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  createAgentSkill,
  deleteAgentSkill,
  getAgentSkill,
  listAgentSkills,
  setAgentSkillEnabled,
  updateAgentSkill
} from '../store/repository-agent-skills.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import type { AgentSkillInstallationSnapshot } from '../types/agents.js';
import { toSingleParam } from '../utils/params.js';

function value(req: AuthenticatedRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

function fail(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, retryable: false, ...(details ? { details } : {}) } });
}

async function context(req: AuthenticatedRequest, res: Response, write = false) {
  const workspaceId = toSingleParam(req.params.workspaceId);
  const authz = write
    ? await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage Agent capabilities')
    : await requireWorkspaceDataRead(req, res, workspaceId);
  if (!authz) return null;
  const agentId = toSingleParam(req.params.agentId);
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) {
    fail(res, 404, 'NOT_FOUND', 'Agent not found');
    return null;
  }
  if (write && agent.kind === 'manager') {
    fail(res, 409, 'MANAGER_OPERATIONAL_CAPABILITY_FORBIDDEN', 'Managers can use coordination functions only.');
    return null;
  }
  return { workspaceId, agentId, agent, authz };
}

function source(input: unknown, fallback: AgentSkillInstallationSnapshot['source'] = { type: 'manual' }): AgentSkillInstallationSnapshot['source'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback;
  const raw = input as Record<string, unknown>;
  if (raw.type !== 'git') return { type: 'manual' };
  return {
    type: 'git',
    ...(raw.provider === 'github' || raw.provider === 'gitlab' ? { provider: raw.provider } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(typeof raw.apiBaseUrl === 'string' ? { apiBaseUrl: raw.apiBaseUrl } : {}),
    ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
    ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
    ...(typeof raw.pinnedCommit === 'string' ? { pinnedCommit: raw.pinnedCommit } : {})
  };
}

function normalizedBundle(input: unknown, res: Response) {
  const bundle = normalizeTargetSkillBundle(Array.isArray(input) ? input : []);
  const limitErrors = getTargetSkillBundleStorageLimitErrors(bundle);
  if (limitErrors.length) {
    fail(res, 400, 'INVALID_SKILL_BUNDLE_LIMIT', 'Skill bundle exceeds storage limits.', { validationErrors: limitErrors });
    return null;
  }
  if (bundle.validationStatus !== 'valid') {
    fail(res, 400, 'INVALID_SKILL', 'The skill bundle must contain a valid SKILL.md.', { validationErrors: bundle.validationErrors });
    return null;
  }
  return bundle;
}

async function audit(req: AuthenticatedRequest, workspaceId: string, agentId: string, skill: AgentSkillInstallationSnapshot, eventType: string, summary: string) {
  await recordWorkspaceAuditEvent({
    workspaceId, category: 'run', eventType, operation: 'write', actorUserId: req.auth.userId,
    objectType: 'agent_skill', objectId: skill.id, objectName: skill.name, summary,
    metadata: { agentId, revision: skill.revision, contentDigest: skill.contentDigest, sourceType: skill.source.type }
  });
}

export async function listSkills(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await context(req, res);
    if (!ctx) return;
    res.status(200).json({ items: await listAgentSkills(ctx.workspaceId, ctx.agentId), canEdit: ctx.authz.can('manage_agents') && ctx.authz.can('manage_skills') });
  } catch (error) { next(error); }
}

export async function createSkill(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await context(req, res, true);
    if (!ctx) return;
    if (!ctx.authz.can('manage_skills')) return fail(res, 403, 'FORBIDDEN', 'Adding skills requires manage_agents and manage_skills.');
    const body = value(req);
    const bundle = normalizedBundle(body.files, res);
    if (!bundle) return;
    const skill = await createAgentSkill({
      workspaceId: ctx.workspaceId, agentId: ctx.agentId, name: bundle.name, description: bundle.description,
      enabled: body.enabled !== false, source: { type: 'manual' },
      files: bundle.files.map((file) => ({ path: file.path, content: file.content })), actorUserId: req.auth.userId
    });
    await syncAgentSkillCapabilitySnapshot(ctx.workspaceId, ctx.agentId);
    await audit(req, ctx.workspaceId, ctx.agentId, skill, 'agent.skill_created.v1', 'Manual skill installed on Agent');
    res.status(201).json({ skill });
  } catch (error) { next(error); }
}

export async function importSkill(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await context(req, res, true);
    if (!ctx) return;
    if (!ctx.authz.can('manage_skills')) return fail(res, 403, 'FORBIDDEN', 'Adding skills requires manage_agents and manage_skills.');
    const body = value(req);
    const bundle = normalizedBundle(body.files, res);
    if (!bundle) return;
    const gitSource = source(body.source);
    if (gitSource.type !== 'git' || !gitSource.provider || !gitSource.url || !gitSource.ref || !gitSource.pinnedCommit) {
      return fail(res, 400, 'AGENT_SKILL_SOURCE_INVALID', 'Git imports require provider, url, ref, and pinnedCommit provenance.');
    }
    const skill = await createAgentSkill({
      workspaceId: ctx.workspaceId, agentId: ctx.agentId, name: bundle.name, description: bundle.description,
      enabled: body.enabled !== false, source: gitSource,
      files: bundle.files.map((file) => ({ path: file.path, content: file.content })), actorUserId: req.auth.userId
    });
    await syncAgentSkillCapabilitySnapshot(ctx.workspaceId, ctx.agentId);
    await audit(req, ctx.workspaceId, ctx.agentId, skill, 'agent.skill_imported.v1', 'Git skill installed on Agent');
    res.status(201).json({ skill });
  } catch (error) { next(error); }
}

export async function getSkill(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await context(req, res);
    if (!ctx) return;
    const skill = await getAgentSkill(ctx.workspaceId, ctx.agentId, toSingleParam(req.params.skillId));
    if (!skill) return fail(res, 404, 'NOT_FOUND', 'Agent skill not found');
    res.status(200).json({ skill });
  } catch (error) { next(error); }
}

export async function patchSkill(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await context(req, res, true);
    if (!ctx) return;
    const body = value(req);
    const skillId = toSingleParam(req.params.skillId);
    const existing = await getAgentSkill(ctx.workspaceId, ctx.agentId, skillId);
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'Agent skill not found');
    const removalOnly = body.enabled === false && Object.keys(body).every((key) => key === 'enabled' || key === 'expectedRevision');
    if (!removalOnly && !ctx.authz.can('manage_skills')) return fail(res, 403, 'FORBIDDEN', 'Editing or enabling skills requires manage_skills.');
    let updated;
    if (removalOnly) {
      updated = await setAgentSkillEnabled(ctx.workspaceId, ctx.agentId, skillId, false,
        typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined);
    } else {
      const bundle = body.files === undefined ? {
        name: existing.name, description: existing.description,
        files: existing.files.map((file) => ({ path: file.path, content: file.content }))
      } : normalizedBundle(body.files, res);
      if (!bundle) return;
      updated = await updateAgentSkill({
        workspaceId: ctx.workspaceId, agentId: ctx.agentId, skillId,
        name: bundle.name, description: bundle.description, enabled: body.enabled === undefined ? existing.enabled : body.enabled === true,
        source: existing.source, files: bundle.files.map((file) => ({ path: file.path, content: file.content })),
        actorUserId: req.auth.userId, expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
      });
    }
    if (!updated) return fail(res, 409, 'AGENT_SKILL_REVISION_CONFLICT', 'The skill changed; reload before updating it.');
    await syncAgentSkillCapabilitySnapshot(ctx.workspaceId, ctx.agentId);
    await audit(req, ctx.workspaceId, ctx.agentId, updated, 'agent.skill_updated.v1', 'Agent skill updated');
    res.status(200).json({ skill: updated });
  } catch (error) { next(error); }
}

export async function reimportSkill(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await context(req, res, true);
    if (!ctx) return;
    if (!ctx.authz.can('manage_skills')) return fail(res, 403, 'FORBIDDEN', 'Reimporting skills requires manage_skills.');
    const skillId = toSingleParam(req.params.skillId);
    const existing = await getAgentSkill(ctx.workspaceId, ctx.agentId, skillId);
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'Agent skill not found');
    if (existing.source.type !== 'git') return fail(res, 400, 'INVALID_SKILL_SOURCE', 'Only Git-imported skills can be reimported.');
    const body = value(req);
    const bundle = normalizedBundle(body.files, res);
    if (!bundle) return;
    const nextSource = source(body.source, existing.source);
    if (nextSource.type !== 'git'
      || nextSource.provider !== existing.source.provider
      || nextSource.url !== existing.source.url
      || nextSource.apiBaseUrl !== existing.source.apiBaseUrl
      || nextSource.path !== existing.source.path) {
      return fail(res, 400, 'SOURCE_MISMATCH', 'Reimport must use the stored Git repository and path.');
    }
    const updated = await updateAgentSkill({
      workspaceId: ctx.workspaceId, agentId: ctx.agentId, skillId, name: bundle.name, description: bundle.description,
      enabled: existing.enabled, source: nextSource, files: bundle.files.map((file) => ({ path: file.path, content: file.content })),
      actorUserId: req.auth.userId, expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : existing.revision
    });
    if (!updated) return fail(res, 409, 'AGENT_SKILL_REVISION_CONFLICT', 'The skill changed; reload before reimporting it.');
    await syncAgentSkillCapabilitySnapshot(ctx.workspaceId, ctx.agentId);
    await audit(req, ctx.workspaceId, ctx.agentId, updated, 'agent.skill_reimported.v1', 'Agent skill explicitly reimported');
    res.status(200).json({ skill: updated });
  } catch (error) { next(error); }
}

export async function removeSkill(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = await context(req, res, true);
    if (!ctx) return;
    const skillId = toSingleParam(req.params.skillId);
    const existing = await getAgentSkill(ctx.workspaceId, ctx.agentId, skillId);
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'Agent skill not found');
    await deleteAgentSkill(ctx.workspaceId, ctx.agentId, skillId);
    await syncAgentSkillCapabilitySnapshot(ctx.workspaceId, ctx.agentId);
    await audit(req, ctx.workspaceId, ctx.agentId, existing, 'agent.skill_deleted.v1', 'Skill removed from Agent');
    res.status(204).end();
  } catch (error) { next(error); }
}
