import { isIP } from 'node:net';
import type { NextFunction, Response } from 'express';
import type { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { getTargetSkillBundleStorageLimitErrors, normalizeTargetSkillBundle } from '../services/target-skills.js';
import {
  createWorkspaceDefault,
  deleteWorkspaceDefault,
  getWorkspaceDefault,
  listWorkspaceDefaults,
  updateWorkspaceDefault
} from '../store/repository-workspace-defaults.js';
import type {
  WorkspaceDefaultAvailability,
  WorkspaceDefaultGitSkillSource,
  WorkspaceDefaultKind,
} from '../types/workspace-defaults.js';
import { toSingleParam } from '../utils/params.js';
import { adminAuditEventInput, notFound, parseStringFilter, validationError } from './admin-controller-common.js';

const privateHostPatterns = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::$/i,
  /^::1$/i,
  /^::ffff:/i,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i
];

export function validWorkspaceDefaultHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    if (url.hash || url.search) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) return null;
    if (privateHostPatterns.some((pattern) => pattern.test(hostname))) return null;
    return url;
  } catch {
    return null;
  }
}

export function validWorkspaceDefaultSkillSource(
  source: Pick<WorkspaceDefaultGitSkillSource, 'provider' | 'repoUrl'>
): boolean {
  const url = validWorkspaceDefaultHttpsUrl(source.repoUrl);
  const expectedHost = source.provider === 'github' ? 'github.com' : 'gitlab.com';
  return url?.hostname.toLowerCase() === expectedHost;
}

function queryEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null {
  if (value === undefined || value === '') return undefined;
  const raw = toSingleParam(value as string | string[]);
  return allowed.includes(raw as T) ? raw as T : null;
}

export async function listDefaults(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const kind = queryEnum<WorkspaceDefaultKind>(req.query.kind, ['mcp_server', 'skill']);
    const availableIn = queryEnum<WorkspaceDefaultAvailability>(
      req.query.availableIn,
      ['agents', 'kubernetes', 'virtual_machines']
    );
    const q = parseStringFilter(req.query.q, 'q');
    if (kind === null || availableIn === null || q.error) {
      validationError(res, q.error || 'Unknown workspace default filter');
      return;
    }
    res.status(200).json({
      items: await listWorkspaceDefaults({ kind, availableIn, q: q.value })
    });
  } catch (error) {
    next(error);
  }
}

export async function createDefault(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = req.admin.actor?.subject || req.admin.tokenId;
    if (req.body.kind === 'mcp_server') {
      if (!validWorkspaceDefaultHttpsUrl(req.body.source.endpoint)) {
        validationError(res, 'MCP endpoint must be an internet-reachable HTTPS URL without credentials, query parameters, or fragments');
        return;
      }
      const created = await createWorkspaceDefault({
        kind: 'mcp_server',
        name: req.body.name,
        availableIn: req.body.availableIn,
        source: req.body.source,
        actorId,
        auditEvent: adminAuditEventInput(req, {
          action: 'admin.system.workspace_default.create',
          subjectType: 'workspace_default',
          reason: req.body.reason,
          metadata: { kind: 'mcp_server', availableIn: req.body.availableIn }
        })
      });
      res.status(201).json(created);
      return;
    }

    if (req.body.source.type === 'git' && !validWorkspaceDefaultSkillSource(req.body.source)) {
      validationError(res, 'Skill sources must use github.com or gitlab.com HTTPS repositories');
      return;
    }
    const bundle = normalizeTargetSkillBundle(req.body.files);
    const limitErrors = getTargetSkillBundleStorageLimitErrors(bundle);
    if (limitErrors.length || bundle.validationStatus !== 'valid') {
      validationError(res, 'The skill bundle must contain a valid SKILL.md and stay within storage limits', {
        validationErrors: [...limitErrors, ...bundle.validationErrors]
      });
      return;
    }
    const created = await createWorkspaceDefault({
      kind: 'skill',
      name: bundle.name,
      description: bundle.description,
      availableIn: req.body.availableIn,
      source: req.body.source,
      files: bundle.files.map((file) => ({ path: file.path, content: file.content })),
      actorId,
      auditEvent: adminAuditEventInput(req, {
        action: 'admin.system.workspace_default.create',
        subjectType: 'workspace_default',
        reason: req.body.reason,
        metadata: { kind: 'skill', availableIn: req.body.availableIn, contentDigest: 'recorded_on_definition' }
      })
    });
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
}

export async function patchDefault(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.id);
    const before = await getWorkspaceDefault(id, false);
    if (!before) {
      notFound(res, 'Workspace default not found');
      return;
    }
    const updated = await updateWorkspaceDefault({
      id,
      availableIn: req.body.availableIn,
      enabled: req.body.enabled,
      actorId: req.admin.actor?.subject || req.admin.tokenId,
      auditEvent: adminAuditEventInput(req, {
        action: 'admin.system.workspace_default.update',
        subjectType: 'workspace_default',
        subjectId: id,
        reason: req.body.reason,
        metadata: {
          kind: before.kind,
          ...(req.body.availableIn === undefined
            ? {}
            : { beforeAvailableIn: before.availableIn, availableIn: req.body.availableIn }),
          ...(req.body.enabled === undefined
            ? {}
            : { beforeEnabled: before.enabled, enabled: req.body.enabled })
        }
      })
    });
    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
}

export async function removeDefault(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.id);
    const existing = await getWorkspaceDefault(id, false);
    if (!existing) {
      notFound(res, 'Workspace default not found');
      return;
    }
    await deleteWorkspaceDefault({
      id,
      auditEvent: adminAuditEventInput(req, {
        action: 'admin.system.workspace_default.delete',
        subjectType: 'workspace_default',
        subjectId: id,
        reason: req.body.reason,
        metadata: { kind: existing.kind, availableIn: existing.availableIn }
      })
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
