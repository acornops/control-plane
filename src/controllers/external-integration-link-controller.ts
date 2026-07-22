import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createExternalIntegrationLink,
  completeExternalIntegrationLink,
  hashExternalIntegrationLinkToken
} from '../auth/external-integration-link.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import {
  assertExternalIntegrationWorkspaceCapabilities,
  getWorkspacePermissions,
  WORKSPACE_CAPABILITIES,
  type WorkspaceCapability
} from '../auth/authorization.js';
import { config, type ExternalIntegrationClientDescriptor } from '../config.js';
import { repo } from '../store/repository.js';
import type {
  ExternalIntegrationGrantableWorkspace,
  ExternalIntegrationUserLinkSummary,
  ExternalIntegrationWorkspaceGrantInput
} from '../store/repository-external-integration-links.js';

const externalIntegrationIdentitySchema = z.object({
  externalUserId: z.string().trim().min(1).max(128),
  externalDisplayName: z.string().trim().min(1).max(120).optional()
}).strict();

const externalIntegrationUserUnlinkSchema = z.object({
  integrationClientId: z.string().trim().min(1).max(128),
  provider: z.string().trim().min(1).max(64),
  externalUserId: z.string().trim().min(1).max(128)
}).strict();

const externalIntegrationLinkTokenSchema = z.object({
  token: z.string().trim().min(1).max(256)
}).strict();

const externalIntegrationWorkspaceGrantSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  capabilities: z.array(z.string().trim().min(1)).max(WORKSPACE_CAPABILITIES.length)
}).strict();

const externalIntegrationLinkCompletionSchema = z.object({
  token: z.string().trim().min(1).max(256),
  workspaceGrants: z.array(externalIntegrationWorkspaceGrantSchema).max(250).optional()
}).strict();

const externalIntegrationWorkspaceGrantsUpdateSchema = z.object({
  workspaceGrants: z.array(externalIntegrationWorkspaceGrantSchema).max(250)
}).strict();

function rejectInvalidIdentity(res: Response): void {
  res.status(400).json({
    error: {
      code: 'INVALID_REQUEST',
      message: 'externalUserId is required as a bounded string',
      retryable: false
    }
  });
}

function externalIdentityObjectId(link: Pick<ExternalIntegrationUserLinkSummary, 'integrationClientId' | 'provider' | 'externalUserId'>): string {
  return `${link.integrationClientId}:${link.provider}:${link.externalUserId}`;
}

function clientForLink(input: { integrationClientId: string; provider: string }): ExternalIntegrationClientDescriptor | null {
  return config.EXTERNAL_INTEGRATION_CLIENTS.find((client) => (
    client.enabled && client.id === input.integrationClientId && client.provider === input.provider
  )) || null;
}

function grantableCapabilitiesForRole(role: string, client: ExternalIntegrationClientDescriptor): WorkspaceCapability[] {
  const rolePermissions = getWorkspacePermissions(role);
  return client.allowedCapabilities.filter((capability) => rolePermissions[capability]);
}

function normalizeRequestedWorkspaceGrants(
  requestedGrants: Array<{ workspaceId: string; capabilities: string[] }> | undefined,
  grantableWorkspaces: ExternalIntegrationGrantableWorkspace[],
  client: ExternalIntegrationClientDescriptor
): ExternalIntegrationWorkspaceGrantInput[] {
  const grantableByWorkspaceId = new Map(grantableWorkspaces.map((workspace) => [workspace.workspaceId, workspace]));
  const seenWorkspaceIds = new Set<string>();
  const normalized: ExternalIntegrationWorkspaceGrantInput[] = [];
  for (const grant of requestedGrants || []) {
    if (seenWorkspaceIds.has(grant.workspaceId)) {
      throw new Error(`Duplicate external integration workspace grant: ${grant.workspaceId}`);
    }
    seenWorkspaceIds.add(grant.workspaceId);
    const workspace = grantableByWorkspaceId.get(grant.workspaceId);
    if (!workspace) {
      throw new Error(`External integration workspace grant is not available: ${grant.workspaceId}`);
    }
    const requestedCapabilities = assertExternalIntegrationWorkspaceCapabilities(grant.capabilities);
    if (!requestedCapabilities.length) {
      continue;
    }
    const grantableCapabilities = new Set(grantableCapabilitiesForRole(workspace.role, client));
    for (const capability of requestedCapabilities) {
      if (!grantableCapabilities.has(capability)) {
        throw new Error(`External integration workspace capability is not grantable: ${capability}`);
      }
    }
    normalized.push({
      workspaceId: grant.workspaceId,
      capabilities: requestedCapabilities
    });
  }
  return normalized;
}

function mapGrantableWorkspaces(
  workspaces: ExternalIntegrationGrantableWorkspace[],
  client: ExternalIntegrationClientDescriptor
): Array<ExternalIntegrationGrantableWorkspace & { grantableCapabilities: WorkspaceCapability[] }> {
  return workspaces.map((workspace) => {
    const grantableCapabilities = grantableCapabilitiesForRole(workspace.role, client);
    const allowedGrantableCapabilities = new Set(grantableCapabilities);
    return {
      ...workspace,
      grantableCapabilities,
      grantedCapabilities: workspace.grantedCapabilities.filter((capability) => allowedGrantableCapabilities.has(capability))
    };
  });
}

function applySavedGrantsToGrantableWorkspaces(
  workspaces: ExternalIntegrationGrantableWorkspace[],
  grants: Array<{ workspaceId: string; capabilities: WorkspaceCapability[] }>
): ExternalIntegrationGrantableWorkspace[] {
  const capabilitiesByWorkspaceId = new Map(grants.map((grant) => [grant.workspaceId, grant.capabilities]));
  return workspaces.map((workspace) => ({
    ...workspace,
    grantedCapabilities: capabilitiesByWorkspaceId.get(workspace.workspaceId) || []
  }));
}

async function recordExternalIntegrationAudit(input: {
  userId?: string | null;
  actorType?: 'user' | 'system' | 'external_integration';
  actorUserId?: string | null;
  actorTokenId?: string | null;
  eventType: string;
  summary: string;
  link: Pick<ExternalIntegrationUserLinkSummary, 'id' | 'integrationClientId' | 'provider' | 'clientDisplayName' | 'externalUserId' | 'externalDisplayName'>;
}): Promise<void> {
  await repo.insertAccountAuditEvent({
    userId: input.userId,
    category: 'security',
    eventType: input.eventType,
    operation: 'write',
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    actorTokenId: input.actorTokenId,
    objectType: 'external_integration_link',
    objectId: input.link.id,
    objectName: externalIdentityObjectId(input.link),
    summary: input.summary,
    metadata: {
      integrationClientId: input.link.integrationClientId,
      provider: input.link.provider,
      clientDisplayName: input.link.clientDisplayName,
      externalUserId: input.link.externalUserId,
      externalDisplayName: input.link.externalDisplayName || null
    }
  });
}

export async function createExternalIntegrationLinkRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = req.externalIntegrationClient;
    if (!client) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'External integration client token required', retryable: false } });
      return;
    }
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const result = await createExternalIntegrationLink(client, parsed.data);
    await repo.insertAccountAuditEvent({
      category: 'security',
      eventType: 'external_integration.link.created.v1',
      operation: 'write',
      actorType: 'external_integration',
      actorTokenId: client.id,
      objectType: 'external_integration_link_token',
      objectName: `${client.id}:${client.provider}:${parsed.data.externalUserId}`,
      summary: 'External integration account link token created',
      metadata: {
        integrationClientId: client.id,
        provider: client.provider,
        clientDisplayName: client.displayName,
        externalUserId: parsed.data.externalUserId,
        externalDisplayName: parsed.data.externalDisplayName || null,
        expiresAt: result.expiresAt
      }
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function resolveExternalIntegrationLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = req.externalIntegrationClient;
    if (!client) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'External integration client token required', retryable: false } });
      return;
    }
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const resolution = await repo.resolveExternalIntegrationUserLink({
      integrationClientId: client.id,
      provider: client.provider,
      externalUserId: parsed.data.externalUserId
    });
    res.status(200).json(resolution || { status: 'unlinked' });
  } catch (err) {
    next(err);
  }
}

export async function previewExternalIntegrationLinkRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationLinkTokenSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'token is required as a bounded string', retryable: false }
      });
      return;
    }
    const user = await repo.getUserById(req.auth.userId);
    const preview = await repo.previewExternalIntegrationLinkToken(hashExternalIntegrationLinkToken(parsed.data.token));
    const client = preview ? clientForLink({
      integrationClientId: preview.integrationClientId,
      provider: preview.provider
    }) : null;
    if (!user || !preview || !client) {
      res.status(410).json({
        error: { code: 'EXTERNAL_INTEGRATION_LINK_EXPIRED', message: 'External integration link token is expired or unavailable', retryable: false }
      });
      return;
    }
    const grantableWorkspaces = await repo.listExternalIntegrationGrantableWorkspaces({
      integrationClientId: preview.integrationClientId,
      provider: preview.provider,
      externalUserId: preview.externalUserId,
      acornopsUserId: user.id
    });
    res.status(200).json({
      ...preview,
      signedInUser: {
        id: user.id,
        email: user.email,
        displayName: user.displayName
      },
      grantableWorkspaces: mapGrantableWorkspaces(grantableWorkspaces, client)
    });
  } catch (err) {
    next(err);
  }
}

export async function completeExternalIntegrationLinkRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationLinkCompletionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'token and workspaceGrants are required in the expected shape', retryable: false }
      });
      return;
    }
    const user = await repo.getUserById(req.auth.userId);
    const preview = await repo.previewExternalIntegrationLinkToken(hashExternalIntegrationLinkToken(parsed.data.token));
    const client = preview ? clientForLink({
      integrationClientId: preview.integrationClientId,
      provider: preview.provider
    }) : null;
    if (!user || !preview || !client) {
      res.status(410).json({
        error: { code: 'EXTERNAL_INTEGRATION_LINK_EXPIRED', message: 'External integration link token is expired or unavailable', retryable: false }
      });
      return;
    }
    const grantableWorkspaces = await repo.listExternalIntegrationGrantableWorkspaces({
      integrationClientId: preview.integrationClientId,
      provider: preview.provider,
      externalUserId: preview.externalUserId,
      acornopsUserId: user.id
    });
    let workspaceGrants: ExternalIntegrationWorkspaceGrantInput[];
    try {
      workspaceGrants = normalizeRequestedWorkspaceGrants(parsed.data.workspaceGrants, grantableWorkspaces, client);
    } catch (error) {
      res.status(400).json({
        error: {
          code: 'INVALID_EXTERNAL_INTEGRATION_GRANTS',
          message: error instanceof Error ? error.message : 'Invalid external integration workspace grants',
          retryable: false
        }
      });
      return;
    }
    const linkWithGrants = await completeExternalIntegrationLink(parsed.data.token, user, workspaceGrants);
    if (!linkWithGrants) {
      res.status(410).json({
        error: { code: 'EXTERNAL_INTEGRATION_LINK_EXPIRED', message: 'External integration link token is expired or unavailable', retryable: false }
      });
      return;
    }
    res.status(200).json({ status: 'linked', link: linkWithGrants });
  } catch (err) {
    next(err);
  }
}

export async function listExternalIntegrationLinks(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const links = await repo.listExternalIntegrationUserLinks(req.auth.userId);
    const linksWithGrantableWorkspaces = await Promise.all(links.map(async (link) => {
      const client = clientForLink(link);
      if (!client) return { ...link, grantableWorkspaces: [] };
      const grantableWorkspaces = await repo.listExternalIntegrationGrantableWorkspaces({
        integrationClientId: link.integrationClientId,
        provider: link.provider,
        externalUserId: link.externalUserId,
        acornopsUserId: req.auth.userId
      });
      return {
        ...link,
        grantableWorkspaces: mapGrantableWorkspaces(grantableWorkspaces, client)
      };
    }));
    res.status(200).json({ links: linksWithGrantableWorkspaces });
  } catch (err) {
    next(err);
  }
}

export async function replaceExternalIntegrationLinkGrants(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const linkId = typeof req.params.linkId === 'string' ? req.params.linkId.trim() : '';
    const parsed = externalIntegrationWorkspaceGrantsUpdateSchema.safeParse(req.body || {});
    if (!linkId || !parsed.success) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'linkId and workspaceGrants are required in the expected shape', retryable: false }
      });
      return;
    }
    const links = await repo.listExternalIntegrationUserLinks(req.auth.userId);
    const link = links.find((item) => item.id === linkId);
    if (!link) {
      res.status(404).json({ error: { code: 'EXTERNAL_INTEGRATION_LINK_NOT_FOUND', message: 'External integration link not found', retryable: false } });
      return;
    }
    const client = clientForLink(link);
    if (!client) {
      res.status(404).json({ error: { code: 'EXTERNAL_INTEGRATION_LINK_NOT_FOUND', message: 'External integration link not found', retryable: false } });
      return;
    }
    const grantableWorkspaces = await repo.listExternalIntegrationGrantableWorkspaces({
      integrationClientId: link.integrationClientId,
      provider: link.provider,
      externalUserId: link.externalUserId,
      acornopsUserId: req.auth.userId
    });
    let workspaceGrants: ExternalIntegrationWorkspaceGrantInput[];
    try {
      workspaceGrants = normalizeRequestedWorkspaceGrants(parsed.data.workspaceGrants, grantableWorkspaces, client);
    } catch (error) {
      res.status(400).json({
        error: {
          code: 'INVALID_EXTERNAL_INTEGRATION_GRANTS',
          message: error instanceof Error ? error.message : 'Invalid external integration workspace grants',
          retryable: false
        }
      });
      return;
    }
    const grants = await repo.replaceExternalIntegrationWorkspaceGrants({
      linkId,
      grantedByUserId: req.auth.userId,
      grants: workspaceGrants
    });
    const linkWithGrants = {
      ...link,
      grants,
      grantableWorkspaces: mapGrantableWorkspaces(
        applySavedGrantsToGrantableWorkspaces(grantableWorkspaces, grants),
        client
      )
    };
    await recordExternalIntegrationAudit({
      userId: req.auth.userId,
      actorType: 'user',
      actorUserId: req.auth.userId,
      eventType: 'external_integration.link.grants_updated.v1',
      summary: 'External integration workspace grants updated',
      link: linkWithGrants
    });
    res.status(200).json({ link: linkWithGrants });
  } catch (err) {
    next(err);
  }
}

export async function unlinkExternalIntegrationLink(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = externalIntegrationUserUnlinkSchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const result = await repo.revokeExternalIntegrationUserLink({
      integrationClientId: parsed.data.integrationClientId,
      provider: parsed.data.provider,
      externalUserId: parsed.data.externalUserId,
      acornopsUserId: req.auth.userId
    });
    if (result.status !== 'revoked' || !result.link) {
      res.status(404).json({ error: { code: 'EXTERNAL_INTEGRATION_LINK_NOT_FOUND', message: 'External integration link not found', retryable: false } });
      return;
    }
    await recordExternalIntegrationAudit({
      userId: req.auth.userId,
      actorType: 'user',
      actorUserId: req.auth.userId,
      eventType: 'external_integration.link.revoked.v1',
      summary: 'External integration account link revoked by user',
      link: result.link
    });
    res.status(200).json({ status: 'revoked', link: result.link });
  } catch (err) {
    next(err);
  }
}

export async function revokeExternalIntegrationLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const client = req.externalIntegrationClient;
    if (!client) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'External integration client token required', retryable: false } });
      return;
    }
    const parsed = externalIntegrationIdentitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      rejectInvalidIdentity(res);
      return;
    }
    const result = await repo.revokeExternalIntegrationUserLink({
      integrationClientId: client.id,
      provider: client.provider,
      externalUserId: parsed.data.externalUserId
    });
    if (result.status !== 'revoked' || !result.link) {
      res.status(404).json({ error: { code: 'EXTERNAL_INTEGRATION_LINK_NOT_FOUND', message: 'External integration link not found', retryable: false } });
      return;
    }
    await recordExternalIntegrationAudit({
      userId: null,
      actorType: 'external_integration',
      actorTokenId: client.id,
      eventType: 'external_integration.link.revoked.v1',
      summary: 'External integration account link revoked by integration client',
      link: result.link
    });
    res.status(200).json({ status: 'revoked' });
  } catch (err) {
    next(err);
  }
}
