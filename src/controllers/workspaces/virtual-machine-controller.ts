import { NextFunction, Response } from 'express';
import { agentGateway } from '../../agent/ws-server.js';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import {
  requireTargetAccess,
  requireWorkspaceCapability,
  requireWorkspaceDataRead
} from '../../auth/workspace-authorization.js';
import type { WorkspaceAuthorization } from '../../auth/workspace-authorization.js';
import { webhooks } from '../../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { repo } from '../../store/repository.js';
import { VIRTUAL_MACHINE_TARGET_TYPE } from '../../types/domain.js';
import type { TargetSummary } from '../../types/domain.js';
import { generateAgentKey, hashSecret } from '../../utils/crypto.js';
import { toSingleParam } from '../../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../../utils/pagination.js';
import { parseBoundedIntQuery, parseMetricLimit, parseMetricWindowMs } from './kubernetes-cluster-request-utils.js';

function buildVmInstallInstructions(input: { targetId: string; agentKey: string; platformUrl?: string }): string {
  return [
    'Install the AcornOps VM agent on a Linux/systemd host:',
    '',
    '```bash',
    'sudo install -d -m 0750 -o root -g root /etc/acornops',
    'sudo tee /etc/acornops/vm-agent.env >/dev/null <<EOF',
    `ACORNOPS_AGENT_PLATFORM_URL=${input.platformUrl || 'https://api.acornops.dev'}`,
    `ACORNOPS_TARGET_ID=${input.targetId}`,
    `ACORNOPS_AGENT_KEY=${input.agentKey}`,
    'ACORNOPS_AGENT_TARGET_TYPE=virtual_machine',
    'ACORNOPS_AGENT_SNAPSHOT_INTERVAL_MS=30000',
    'ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES=1048576',
    'ACORNOPS_AGENT_LOG_LEVEL=info',
    'ACORNOPS_VM_OS_FAMILY=linux',
    'ACORNOPS_VM_SERVICE_MANAGER=systemd',
    'ACORNOPS_VM_ALLOWED_LOG_SOURCES=journald,syslog',
    'ACORNOPS_VM_COLLECTOR_MODE=live',
    'EOF',
    'sudo chown root:acornops-agent /etc/acornops/vm-agent.env',
    'sudo chmod 0640 /etc/acornops/vm-agent.env',
    'sudo systemctl enable --now acornops-vm-agent',
    '```',
    '',
    'The agent connects outbound only and exposes read-only diagnostics.'
  ].join('\n');
}

async function requireVirtualMachineTargetAccess(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string,
  vmId: string
): Promise<{ authz: WorkspaceAuthorization; target: TargetSummary } | null> {
  const access = await requireTargetAccess(req, res, workspaceId, vmId);
  if (!access) return null;
  if (access.target.targetType !== VIRTUAL_MACHINE_TARGET_TYPE) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Virtual machine not found', retryable: false } });
    return null;
  }
  return access;
}

export async function registerVirtualMachine(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_targets', 'Only workspace roles with target management capability can register VMs'))) {
      return;
    }
    const vm = await repo.addVirtualMachine(workspaceId, {
      name: req.body.name,
      hostname: req.body.hostname,
      allowedLogSources: req.body.allowedLogSources
    });
    const rawAgentKey = generateAgentKey(vm.id);
    await repo.upsertTargetAgentRegistration({
      targetId: vm.id,
      targetType: VIRTUAL_MACHINE_TARGET_TYPE,
      workspaceId: vm.workspaceId,
      agentKeyHash: hashSecret(rawAgentKey),
      keyVersion: 1,
      capabilities: ['read', 'logs', 'mcp', 'chat', 'systemd', 'linux']
    });
    webhooks.emit({
      type: 'target.registered.v1',
      workspaceId,
      targetId: vm.id,
      targetType: VIRTUAL_MACHINE_TARGET_TYPE,
      subject: { type: 'target', id: vm.id },
      data: { targetType: VIRTUAL_MACHINE_TARGET_TYPE, name: vm.name, status: vm.status, createdAt: vm.createdAt }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'target.registered.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'virtual_machine',
      objectId: vm.id,
      objectName: vm.name,
      summary: 'Virtual machine registered',
      metadata: { status: vm.status, osFamily: vm.osFamily, serviceManager: vm.serviceManager }
    });
    res.status(201).json({
      virtualMachine: vm,
      agentKey: rawAgentKey,
      keyVersion: 1,
      installInstructions: buildVmInstallInstructions({ targetId: vm.id, agentKey: rawAgentKey })
    });
  } catch (err) {
    next(err);
  }
}

export async function listVirtualMachines(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const q = normalizeSearchQuery(req.query.q);
    const status = toSingleParam(req.query.status as string | string[] | undefined);
    const filters = {
      q,
      status: ['online', 'offline', 'degraded', 'unknown'].includes(status) ? status : undefined
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ createdAt: string; vmId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listVirtualMachines(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      q,
      status: filters.status as never,
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

export async function getVirtualMachine(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    const access = await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId);
    if (!access) return;
    const vm = await repo.getVirtualMachine(vmId);
    if (!vm) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Virtual machine not found', retryable: false } });
      return;
    }
    const snapshot = await repo.getVirtualMachineSnapshot(vmId);
    res.status(200).json({
      ...vm,
      latestSnapshot: snapshot ? { targetId: vmId, workspaceId, timestamp: snapshot.timestamp } : null
    });
  } catch (err) {
    next(err);
  }
}

export async function updateVirtualMachine(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    const access = await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId);
    if (!access) return;
    if (!access.authz.can('manage_targets')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only workspace roles with target management capability can update VMs', retryable: false } });
      return;
    }
    const previous = await repo.getVirtualMachine(vmId);
    const vm = await repo.updateVirtualMachine(vmId, {
      name: req.body.name,
      hostname: req.body.hostname,
      allowedLogSources: req.body.allowedLogSources
    });
    if (!vm) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Virtual machine not found', retryable: false } });
      return;
    }
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'target.updated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'virtual_machine',
      objectId: vm.id,
      objectName: vm.name,
      summary: 'Virtual machine settings updated',
      metadata: {
        nameChanged: previous ? previous.name !== vm.name : false,
        hostnameChanged: previous ? (previous.hostname || null) !== (vm.hostname || null) : false,
        allowedLogSourcesChanged: previous
          ? JSON.stringify(previous.allowedLogSources) !== JSON.stringify(vm.allowedLogSources)
          : false
      }
    });
    res.status(200).json(vm);
  } catch (err) {
    next(err);
  }
}

export async function deleteVirtualMachine(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    const access = await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId);
    if (!access) return;
    if (!access.authz.can('manage_targets')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only workspace roles with target management capability can delete VMs', retryable: false } });
      return;
    }
    const targetName = access.target.name;
    await agentGateway.disconnectCluster(vmId, 'VM target deleted');
    const deleted = await repo.deleteVirtualMachine(vmId);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Virtual machine not found', retryable: false } });
      return;
    }
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'target.deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'virtual_machine',
      objectId: vmId,
      objectName: targetName,
      summary: 'Virtual machine deleted',
      metadata: {}
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function rotateVirtualMachineAgentKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    const access = await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId);
    if (!access) return;
    if (!access.authz.can('manage_agent_keys')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only workspace roles with agent-key management capability can rotate agent keys', retryable: false } });
      return;
    }
    const reg = await repo.getTargetAgentRegistration(vmId);
    if (!reg) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent registration not found', retryable: false } });
      return;
    }
    const rawAgentKey = generateAgentKey(vmId);
    await repo.upsertTargetAgentRegistration({
      ...reg,
      agentKeyHash: hashSecret(rawAgentKey),
      keyVersion: reg.keyVersion + 1
    });
    await agentGateway.disconnectCluster(vmId, 'Agent key rotated');
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'agent.key_rotated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'virtual_machine',
      objectId: vmId,
      objectName: access.target.name,
      summary: 'VM agent key rotated',
      metadata: { keyVersion: reg.keyVersion + 1 }
    });
    res.status(200).json({
      targetId: vmId,
      agentKey: rawAgentKey,
      keyVersion: reg.keyVersion + 1,
      installInstructions: buildVmInstallInstructions({ targetId: vmId, agentKey: rawAgentKey })
    });
  } catch (err) {
    next(err);
  }
}

export async function listVirtualMachineInventory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    if (!(await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId))) return;
    const items = await repo.listVirtualMachineInventory(vmId);
    res.status(200).json({ items });
  } catch (err) {
    next(err);
  }
}

export async function listVirtualMachineFindings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    if (!(await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId))) return;
    const items = await repo.listVirtualMachineFindings(vmId);
    res.status(200).json({ items });
  } catch (err) {
    next(err);
  }
}

export async function getVirtualMachineMetricsHistory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    if (!(await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId))) return;
    const windowMs = parseMetricWindowMs(req.query.window);
    const limit = parseMetricLimit(req.query.limit);
    const since = new Date(Date.now() - windowMs).toISOString();
    const snapshots = await repo.listVirtualMachineSnapshotHistory(vmId, { since, limit });
    const points = snapshots.map((snapshot) => ({
      timestamp: snapshot.timestamp,
      loadAverage: (snapshot.data.metrics as { loadAverage?: unknown } | undefined)?.loadAverage || [],
      memory: (snapshot.data.metrics as { memory?: unknown } | undefined)?.memory || null,
      disks: (snapshot.data.metrics as { disks?: unknown } | undefined)?.disks || []
    }));
    res.status(200).json({ workspaceId, targetId: vmId, windowMs, points });
  } catch (err) {
    next(err);
  }
}

export async function getVirtualMachineLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    const access = await requireVirtualMachineTargetAccess(req, res, workspaceId, vmId);
    if (!access) return;
    if (!access.authz.can('read_target_logs')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only workspace operators/admins/owners can read VM logs', retryable: false } });
      return;
    }
    const tailLines = parseBoundedIntQuery(req.query.tailLines || req.query.tail_lines, 200, 1, 5000);
    const limitBytes = parseBoundedIntQuery(req.query.limitBytes || req.query.limit_bytes, 1024 * 1024, 1, 10 * 1024 * 1024);
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    const toolName = query ? 'search_logs' : 'get_logs';
    const startedAt = Date.now();
    try {
      const result = await agentGateway.callAgentTool(vmId, toolName, {
        source,
        query,
        tail_lines: tailLines,
        limit_bytes: limitBytes
      });
      webhooks.emit({
        type: 'tool.called.v1',
        workspaceId,
        targetId: vmId,
        targetType: VIRTUAL_MACHINE_TARGET_TYPE,
        subject: { type: 'tool_call', id: `${vmId}:${toolName}:${Date.now()}` },
        data: {
          toolName,
          source: 'management_console_vm_logs',
          durationMs: Date.now() - startedAt,
          isError: false
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'tool',
        eventType: 'tool.called.v1',
        operation: 'read',
        actorUserId: req.auth.userId,
        objectType: 'tool_call',
        objectId: `${vmId}:${toolName}:${startedAt}`,
        objectName: toolName,
        summary: 'VM log tool called',
        metadata: {
          targetId: vmId,
          targetType: VIRTUAL_MACHINE_TARGET_TYPE,
          toolName,
          source: 'management_console_vm_logs',
          logSource: source || null,
          queried: Boolean(query),
          tailLines,
          limitBytes,
          durationMs: Date.now() - startedAt,
          isError: false
        }
      });
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent log request failed';
      webhooks.emit({
        type: 'tool.called.v1',
        workspaceId,
        targetId: vmId,
        targetType: VIRTUAL_MACHINE_TARGET_TYPE,
        subject: { type: 'tool_call', id: `${vmId}:${toolName}:${Date.now()}` },
        data: {
          toolName,
          source: 'management_console_vm_logs',
          durationMs: Date.now() - startedAt,
          isError: true,
          error: message
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'tool',
        eventType: 'tool.called.v1',
        operation: 'read',
        actorUserId: req.auth.userId,
        objectType: 'tool_call',
        objectId: `${vmId}:${toolName}:${startedAt}`,
        objectName: toolName,
        summary: 'VM log tool call failed',
        metadata: {
          targetId: vmId,
          targetType: VIRTUAL_MACHINE_TARGET_TYPE,
          toolName,
          source: 'management_console_vm_logs',
          logSource: source || null,
          queried: Boolean(query),
          tailLines,
          limitBytes,
          durationMs: Date.now() - startedAt,
          isError: true
        }
      });
      const status = /not connected|timed out/i.test(message) ? 503 : 502;
      res.status(status).json({
        error: {
          code: status === 503 ? 'AGENT_UNAVAILABLE' : 'AGENT_TOOL_ERROR',
          message,
          retryable: status === 503
        }
      });
    }
  } catch (err) {
    next(err);
  }
}
