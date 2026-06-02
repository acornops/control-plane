import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';
import { distributedRoutingEnabled } from './common.js';

export interface AgentOwnerRecord {
  instanceId: string;
  connectionId: string;
  workspaceId: string;
  agentVersion?: string;
  updatedAt: string;
}

const deleteAgentOwnerIfMatchScript = `
local current = redis.call("GET", KEYS[1])
if not current then
  return 0
end
local ok, decoded = pcall(cjson.decode, current)
if not ok then
  return 0
end
if decoded["instanceId"] == ARGV[1] and decoded["connectionId"] == ARGV[2] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const renewAgentOwnerIfMatchScript = `
local current = redis.call("GET", KEYS[1])
if not current then
  return 0
end
local ok, decoded = pcall(cjson.decode, current)
if not ok then
  return 0
end
if decoded["instanceId"] == ARGV[1] and decoded["connectionId"] == ARGV[2] then
  decoded["updatedAt"] = ARGV[4]
  redis.call("SET", KEYS[1], cjson.encode(decoded), "EX", ARGV[3])
  return 1
end
return 0
`;

function agentOwnerKey(clusterId: string): string {
  return `cp:agent:owner:${clusterId}`;
}

function parseAgentOwnerRecord(value: string | null): AgentOwnerRecord | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.instanceId !== 'string' ||
      typeof record.connectionId !== 'string' ||
      typeof record.workspaceId !== 'string' ||
      typeof record.updatedAt !== 'string'
    ) {
      return undefined;
    }
    return {
      instanceId: record.instanceId,
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
      agentVersion: typeof record.agentVersion === 'string' ? record.agentVersion : undefined,
      updatedAt: record.updatedAt
    };
  } catch {
    return undefined;
  }
}

export async function claimAgentOwner(input: {
  clusterId: string;
  connectionId: string;
  workspaceId: string;
  agentVersion?: string;
}): Promise<void> {
  if (!distributedRoutingEnabled()) return;
  const record: AgentOwnerRecord = {
    instanceId: config.CONTROL_PLANE_INSTANCE_ID,
    connectionId: input.connectionId,
    workspaceId: input.workspaceId,
    agentVersion: input.agentVersion,
    updatedAt: new Date().toISOString()
  };
  await redis.set(agentOwnerKey(input.clusterId), JSON.stringify(record), 'EX', config.CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS);
}

export async function getAgentOwner(clusterId: string): Promise<AgentOwnerRecord | undefined> {
  if (!distributedRoutingEnabled()) return undefined;
  return parseAgentOwnerRecord(await redis.get(agentOwnerKey(clusterId)));
}

export async function isCurrentAgentOwner(clusterId: string, connectionId: string): Promise<boolean> {
  if (!distributedRoutingEnabled()) return true;
  const owner = await getAgentOwner(clusterId);
  return owner?.instanceId === config.CONTROL_PLANE_INSTANCE_ID && owner.connectionId === connectionId;
}

export async function refreshAgentOwner(clusterId: string, connectionId: string): Promise<boolean> {
  if (!distributedRoutingEnabled()) return true;
  const renewed = await redis.eval(
    renewAgentOwnerIfMatchScript,
    1,
    agentOwnerKey(clusterId),
    config.CONTROL_PLANE_INSTANCE_ID,
    connectionId,
    String(config.CONTROL_PLANE_AGENT_OWNER_TTL_SECONDS),
    new Date().toISOString()
  );
  return renewed === 1;
}

export async function clearAgentOwnerIfCurrent(clusterId: string, connectionId: string): Promise<boolean> {
  if (!distributedRoutingEnabled()) return true;
  const deleted = await redis.eval(
    deleteAgentOwnerIfMatchScript,
    1,
    agentOwnerKey(clusterId),
    config.CONTROL_PLANE_INSTANCE_ID,
    connectionId
  );
  return deleted === 1;
}
