import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { getConfiguredRoleTemplate, isSupportedRole } from '../auth/authorization.js';
import {
  getEffectiveWorkspacePermissions,
  requireWorkspaceCapability,
  requireWorkspaceDataRead,
  requireWorkspaceRead
} from '../auth/workspace-authorization.js';
import {
  deleteTargetMcpServer,
  LlmGatewayHttpError,
  listTargetMcpServers
} from '../services/mcp-registry-client.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import { buildWorkspaceQuota } from '../store/repository-quotas.js';
import { TargetSummary, WorkspaceSummary } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../utils/pagination.js';

import { mapGatewayError } from './workspaces/common.js';
import { cleanupWorkspaceAiProviderCredentials } from './workspaces/ai-settings-controller.js';

const AI_GATEWAY_UPSTREAM_MESSAGE = 'Failed to synchronize AI provider settings with llm-gateway';

export function applyWorkspaceSummaryPermissions(
  workspace: WorkspaceSummary,
  permissions: WorkspaceSummary['permissions']
): WorkspaceSummary {
  const canReadWorkspaceData = permissions.read_workspace_data;
  const canReadMembers = permissions.read_members;
  return {
    ...workspace,
    permissions,
    clusterCount: canReadWorkspaceData ? workspace.clusterCount : 0,
    memberCount: canReadMembers ? workspace.memberCount : 0,
    quota: buildWorkspaceQuota({
      planKey: workspace.plan.key,
      members: canReadMembers ? workspace.quota.members.used : 0,
      kubernetesClusters: canReadWorkspaceData ? workspace.quota.kubernetesClusters.used : 0,
      virtualMachines: canReadWorkspaceData ? workspace.quota.virtualMachines.used : 0,
      canReadWorkspaceData
    })
  };
}

function withEffectiveWorkspacePermissions(req: AuthenticatedRequest, workspace: WorkspaceSummary): WorkspaceSummary | null {
  if (!isSupportedRole(workspace.currentUserRole)) {
    return null;
  }
  return applyWorkspaceSummaryPermissions(workspace, getEffectiveWorkspacePermissions(req, workspace.currentUserRole));
}

async function cleanupTargetMcpServers(target: TargetSummary): Promise<void> {
  const servers = await listTargetMcpServers(target.workspaceId, target.id, target.targetType);
  for (const server of servers) {
    await deleteTargetMcpServer(target.workspaceId, target.id, target.targetType, server.id);
  }
}

export async function listWorkspaces(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ q });
    const cursor = decodeCursor<{ createdAt: string; workspaceId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listWorkspacesForUser(req.auth.userId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      q,
      signature
    });
    const items = page.items
      .map((workspace) => withEffectiveWorkspacePermissions(req, workspace))
      .filter((workspace): workspace is WorkspaceSummary => Boolean(workspace));
    res.status(200).json({ ...page, items });
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const workspace = await repo.getWorkspaceSummaryForUser(req.auth.userId, workspaceId);
    if (!workspace || !isSupportedRole(workspace.currentUserRole)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found', retryable: false } });
      return;
    }
    res.status(200).json(withEffectiveWorkspacePermissions(req, workspace));
  } catch (err) {
    next(err);
  }
}

export async function listWorkspaceRoleTemplates(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceRead(req, res, workspaceId, 'No access to workspace roles'))) {
      return;
    }
    res.status(200).json({ items: await repo.listRoleTemplates() });
  } catch (err) {
    next(err);
  }
}

export async function createWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const ws = await repo.addWorkspace(req.body.name, req.auth.userId);
    webhooks.emit({
      type: 'workspace.created.v1',
      workspaceId: ws.id,
      subject: { type: 'workspace', id: ws.id },
      data: {
        name: ws.name,
        createdBy: ws.createdBy,
        createdAt: ws.createdAt
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId: ws.id,
      category: 'workspace',
      eventType: 'workspace.created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      targetType: 'workspace',
      targetId: ws.id,
      targetName: ws.name,
      summary: 'Workspace created',
      metadata: { name: ws.name }
    });
    const permissions = getEffectiveWorkspacePermissions(req, 'owner');
    const createdSummary: WorkspaceSummary = {
      ...ws,
      currentUserRole: 'owner',
      currentUserRoleTemplate: getConfiguredRoleTemplate('owner'),
      permissions,
      clusterCount: 0,
      memberCount: 1,
      quota: buildWorkspaceQuota({
        planKey: ws.plan.key,
        members: 1,
        kubernetesClusters: 0,
        virtualMachines: 0,
        canReadWorkspaceData: true
      })
    };
    res.status(201).json(applyWorkspaceSummaryPermissions(createdSummary, permissions));
  } catch (err) {
    next(err);
  }
}

export async function listWorkspaceInvestigations(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) {
      return;
    }

    const q = normalizeSearchQuery(req.query.q);
    const filters = {
      q,
      severity: toSingleParam(req.query.severity as string | string[] | undefined),
      clusterId: toSingleParam(req.query.clusterId as string | string[] | undefined),
      namespace: toSingleParam(req.query.namespace as string | string[] | undefined)
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ severityRank: number; findingTs: string; findingId: string; signature: string }>(
      req.query.cursor,
      signature
    );
    const page = await repo.listWorkspaceSnapshotFindings(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      q,
      severity: filters.severity,
      clusterId: filters.clusterId,
      namespace: filters.namespace,
      signature
    });
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function deleteWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'delete_workspace',
        'Only workspace owners can delete this workspace'
      ))
    ) {
      return;
    }
    const workspace = await repo.getWorkspaceSummaryForUser(req.auth.userId, workspaceId);

    const targets: TargetSummary[] = [];
    let cursor: string | undefined;
    do {
      const signature = makeQuerySignature({});
      const decoded = decodeCursor<{ createdAt: string; targetId: string; signature: string }>(cursor, signature);
      const page = await repo.listTargets(workspaceId, { limit: 100, cursor: decoded, signature });
      targets.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    await cleanupWorkspaceAiProviderCredentials(workspaceId);
    for (const target of targets) {
      await cleanupTargetMcpServers(target);
    }
    const clusterCount = targets.filter((target) => target.targetType === 'kubernetes').length;

    const workspaceDeletedWebhook = await webhooks.prepare({
      type: 'workspace.deleted.v1',
      workspaceId,
      subject: { type: 'workspace', id: workspaceId },
      data: {
        deletedBy: req.auth.userId,
        clusterCount
      }
    });

    const deleted = await repo.deleteWorkspace(workspaceId);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found', retryable: false } });
      return;
    }

    webhooks.emitPrepared(workspaceDeletedWebhook);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'workspace',
      eventType: 'workspace.deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      targetType: 'workspace',
      targetId: workspaceId,
      targetName: workspace?.name || null,
      summary: 'Workspace deleted',
      metadata: { clusterCount }
    });
    res.status(204).send();
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export {
  deleteWorkspaceAiProviderCredential,
  getWorkspaceAiSettings,
  updateWorkspaceAiSettings,
  upsertWorkspaceAiProviderCredential
} from './workspaces/ai-settings-controller.js';

export {
  listWorkspaceAuditEvents
} from './workspaces/audit-controller.js';

export {
  acceptWorkspaceInvitation,
  addWorkspaceMember,
  createWorkspaceInvitation,
  deleteWorkspaceMember,
  getWorkspaceInvitation,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  revokeWorkspaceInvitation,
  updateWorkspaceMember
} from './workspaces/members-controller.js';

export {
  listKubernetesClusterToolsCatalog
} from './workspaces/kubernetes-cluster-mcp-controller.js';

export {
  createTargetMcpServerForTarget,
  deleteTargetMcpServerForTarget,
  listTargetMcpServerTools,
  listTargetMcpServers,
  listTargetToolsCatalog,
  testTargetMcpServerConnectionForTarget,
  updateTargetMcpServerForTarget,
  updateTargetToolSettings
} from './workspaces/target-tool-controller.js';

export {
  getTarget,
  listTargets
} from './workspaces/target-controller.js';

export {
  getCluster,
  getClusterMetricsHistory,
  getWorkspaceClusterMetricsHistory,
  getPodLogs,
  listClusterFindings,
  listClusterResources,
  listClusters,
  registerCluster,
  rotateAgentKey,
  updateCluster
} from './workspaces/kubernetes-cluster-controller.js';

export {
  deleteCluster
} from './workspaces/kubernetes-cluster-delete-controller.js';

export {
  deleteVirtualMachine,
  getVirtualMachine,
  getVirtualMachineLogs,
  getVirtualMachineMetricsHistory,
  listVirtualMachineFindings,
  listVirtualMachineInventory,
  listVirtualMachines,
  registerVirtualMachine,
  rotateVirtualMachineAgentKey,
  updateVirtualMachine
} from './workspaces/virtual-machine-controller.js';
