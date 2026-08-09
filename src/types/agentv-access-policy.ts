type AgentVAccessMode = 'read_only' | 'read_write';

export interface AgentVAccessPolicy {
  accessMode: AgentVAccessMode;
  restartServices: string[];
}

export const AGENTV_RESTART_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}\.service$/;
export const AGENTV_MAX_RESTART_SERVICES = 32;

export const READ_ONLY_AGENTV_ACCESS_POLICY: AgentVAccessPolicy = {
  accessMode: 'read_only',
  restartServices: []
};

export function isProtectedAgentVUnit(unit: string): boolean {
  return unit === 'acornops-agentv.service' || unit.startsWith('acornops-agentv-');
}

export function parseAgentVAccessPolicy(value: unknown): AgentVAccessPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'accessMode' && key !== 'restartServices')
    || (input.accessMode !== 'read_only' && input.accessMode !== 'read_write')
    || !Array.isArray(input.restartServices)
    || input.restartServices.length > AGENTV_MAX_RESTART_SERVICES
    || !input.restartServices.every((unit) => typeof unit === 'string'
      && AGENTV_RESTART_SERVICE_PATTERN.test(unit)
      && !isProtectedAgentVUnit(unit))
    || new Set(input.restartServices).size !== input.restartServices.length
    || (input.accessMode === 'read_only' && input.restartServices.length !== 0)
    || (input.accessMode === 'read_write' && input.restartServices.length === 0)) {
    return null;
  }
  return { accessMode: input.accessMode, restartServices: [...input.restartServices] };
}

export function agentVAccessPoliciesEqual(left: AgentVAccessPolicy, right: AgentVAccessPolicy): boolean {
  const leftServices = [...left.restartServices].sort();
  const rightServices = [...right.restartServices].sort();
  return left.accessMode === right.accessMode
    && leftServices.length === rightServices.length
    && leftServices.every((unit, index) => unit === rightServices[index]);
}
