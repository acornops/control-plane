import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { claimAgentOwner, refreshAgentOwner } from '../services/control-plane-coordination.js';
import { webhooks } from '../services/webhooks.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE, isTargetType } from '../types/domain.js';
import { createErrorResponse, createSuccessResponse } from '../types/jsonrpc.js';
import { extractClusterIdFromAgentKey, verifySecret } from '../utils/crypto.js';
import { closeStaleAgentConnection, getAgentConnection, setAgentConnection } from './connections.js';
import { scheduleBuiltInToolSync } from './tool-sync-scheduler.js';

export async function handleAgentHandshake(input: {
  ws: WebSocket;
  requestId: string | number;
  params: Record<string, unknown>;
  agentKeyHeader: string;
  agentVersion: string;
}): Promise<void> {
  const suppliedKey = String((input.params.agentKey as string | undefined) || '');
  const effectiveKey = suppliedKey || input.agentKeyHeader;
  const targetId = typeof input.params.targetId === 'string' ? input.params.targetId.trim() : '';
  const targetType = typeof input.params.targetType === 'string' ? input.params.targetType.trim() : '';
  const agentType = typeof input.params.agentType === 'string' ? input.params.agentType.trim() : '';
  const keyTargetId = extractClusterIdFromAgentKey(effectiveKey);
  const supportedCapabilities = Array.isArray(input.params.supportedCapabilities)
    ? input.params.supportedCapabilities
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  const expectedAgentType = targetType === VIRTUAL_MACHINE_TARGET_TYPE ? 'agentv' : 'agentk';
  if (!targetId || !isTargetType(targetType) || agentType !== expectedAgentType || (keyTargetId && targetId !== keyTargetId)) {
    input.ws.send(JSON.stringify(createErrorResponse(input.requestId, 401, 'Invalid agent key')));
    input.ws.close(1008, 'Invalid agent key');
    return;
  }

  const reg = await repo.getTargetAgentRegistration(targetId);
  if (!reg || reg.targetType !== targetType || !verifySecret(effectiveKey, reg.agentKeyHash)) {
    input.ws.send(JSON.stringify(createErrorResponse(input.requestId, 401, 'Invalid agent key')));
    input.ws.close(1008, 'Invalid agent key');
    return;
  }

  const previousCapabilities = reg.capabilities || [];
  await repo.upsertTargetAgentRegistration({ ...reg, capabilities: supportedCapabilities });

  const now = new Date().toISOString();
  await repo.updateTargetAgentSeen(reg.targetId, {
    lastSeenAt: now,
    lastHeartbeatAt: now,
    lastAgentVersion: input.agentVersion
  });

  const target = targetType === KUBERNETES_TARGET_TYPE
    ? await repo.getCluster(reg.targetId)
    : await repo.getVirtualMachine(reg.targetId);
  if (!target) {
    input.ws.send(JSON.stringify(createErrorResponse(input.requestId, 404, 'Target registration not found')));
    return;
  }

  const updatedTarget = targetType === KUBERNETES_TARGET_TYPE
    ? await repo.updateCluster(target.id, { status: 'online' })
    : await repo.updateVirtualMachine(target.id, { status: 'online' });
  const connectionId = randomUUID();
  await claimAgentOwner({
    clusterId: target.id,
    connectionId,
    workspaceId: target.workspaceId,
    agentVersion: input.agentVersion
  });
  await repo.updateTargetAgentSeen(target.id, { lastConnectionId: connectionId });

  const previousLocalConnection = getAgentConnection(target.id);
  if (previousLocalConnection && previousLocalConnection.ws !== input.ws) {
    closeStaleAgentConnection(target.id, previousLocalConnection);
  }

  const ownerRefreshInterval = setInterval(() => {
    Promise.all([
      refreshAgentOwner(target.id, connectionId),
      repo.getTargetAgentRegistration(target.id)
    ])
      .then(([stillOwner, currentRegistration]) => {
        if (currentRegistration?.keyVersion !== reg.keyVersion) {
          const conn = getAgentConnection(target.id);
          if (conn && conn.connectionId === connectionId && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.close(1008, 'Agent key rotated');
          }
          return;
        }
        if (!stillOwner) {
          const conn = getAgentConnection(target.id);
          if (conn && conn.connectionId === connectionId) {
            closeStaleAgentConnection(target.id, conn);
          }
        }
      })
      .catch((err) => {
        logger.warn({ err, targetId: target.id, targetType }, 'Failed refreshing agent owner');
      });
  }, Math.max(5_000, Math.floor(config.CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS * 1000 / 3)));
  ownerRefreshInterval.unref();

  setAgentConnection(target.id, {
    connectionId,
    ws: input.ws,
    clusterId: target.id,
    targetType,
    workspaceId: target.workspaceId,
    keyVersion: reg.keyVersion,
    agentVersion: input.agentVersion,
    ownerRefreshInterval
  });

  webhooks.emit({
    type: 'agent.connected.v1',
    workspaceId: target.workspaceId,
    clusterId: targetType === KUBERNETES_TARGET_TYPE ? target.id : undefined,
    targetId: target.id,
    targetType,
    subject: { type: 'agent', id: target.id },
    data: {
      connectionId,
      agentVersion: input.agentVersion,
      capabilities: supportedCapabilities
    }
  });
  if (target.status !== 'online') {
    webhooks.emit({
      type: 'target.status_changed.v1',
      workspaceId: target.workspaceId,
      clusterId: targetType === KUBERNETES_TARGET_TYPE ? target.id : undefined,
      targetId: target.id,
      targetType,
      subject: { type: 'target', id: target.id },
      data: {
        targetType,
        previousStatus: target.status,
        status: 'online',
        updatedAt: updatedTarget?.updatedAt || new Date().toISOString()
      }
    });
  }
  if (JSON.stringify([...previousCapabilities].sort()) !== JSON.stringify([...supportedCapabilities].sort())) {
    webhooks.emit({
      type: 'agent.capabilities_changed.v1',
      workspaceId: target.workspaceId,
      clusterId: targetType === KUBERNETES_TARGET_TYPE ? target.id : undefined,
      targetId: target.id,
      targetType,
      subject: { type: 'agent', id: target.id },
      data: {
        previousCapabilities,
        capabilities: supportedCapabilities
      }
    });
  }

  scheduleBuiltInToolSync(target.workspaceId, target.id, targetType);
  input.ws.send(JSON.stringify(createSuccessResponse(input.requestId, {
    workspaceId: target.workspaceId,
    targetId: target.id,
    targetType,
    sessionPolicy: {
      allowedTools: targetType === KUBERNETES_TARGET_TYPE
        ? [
          'list_resources',
          'get_resource',
          'get_resource_logs',
          'restart_workload',
          'scale_workload',
          'simulate_patch',
          'apply_remediation'
        ]
        : [
          'get_host_summary',
          'list_processes',
          'get_process',
          'list_services',
          'get_service_status',
          'get_logs',
          'search_logs',
          'check_port',
          'list_listening_ports'
        ],
      writeEnabled: supportedCapabilities.includes('write')
    },
    config: {
      snapshotInterval: config.CONTROL_PLANE_AGENT_SNAPSHOT_INTERVAL_SECONDS,
      maxSnapshotBytes: 5 * 1024 * 1024,
      namespaceScope: targetType === KUBERNETES_TARGET_TYPE && 'namespaceInclude' in target
        ? {
          include: target.namespaceInclude,
          exclude: target.namespaceExclude
        }
        : undefined
    }
  })));
}
