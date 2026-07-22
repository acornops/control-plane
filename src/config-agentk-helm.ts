import { z } from 'zod';

export type AgentKHelmValue = string | number | boolean | null | AgentKHelmValue[] | AgentKHelmValues;
export interface AgentKHelmValues {
  [key: string]: AgentKHelmValue;
}

const RESERVED_VALUE_PATHS = [
  ['clusterName'],
  ['existingSecret'],
  ['namespaceScope'],
  ['config', 'platformUrl'],
  ['config', 'websocketUrl'],
  ['config', 'clusterId'],
  ['config', 'agentKey'],
  ['config', 'watchNamespaces'],
  ['config', 'tls', 'additionalCaBundle', 'inlinePem'],
  ['rbac', 'write', 'enabled']
] as const;

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

const optionalStringFromEnv = z.preprocess(emptyStringToUndefined, z.string().optional());

export const agentKHelmConfigFields = {
  AGENTK_HELM_RELEASE_NAME: z.preprocess(emptyStringToUndefined, z.string().min(1).default('acornops-agentk')),
  AGENTK_HELM_CHART_REF: z.preprocess(emptyStringToUndefined, z.string().min(1).default('oci://ghcr.io/acornops/charts/acornops-agentk')),
  AGENTK_HELM_CHART_VERSION: optionalStringFromEnv,
  AGENTK_HELM_NAMESPACE: z.preprocess(emptyStringToUndefined, z.string().min(1).default('acornops-agentk')),
  AGENTK_HELM_VALUES_JSON: optionalStringFromEnv,
  AGENTK_HELM_ADDITIONAL_CA_FILE_PATH: optionalStringFromEnv
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function overridesReservedPath(values: AgentKHelmValues, path: readonly string[]): boolean {
  let current: unknown = values;
  for (const [index, segment] of path.entries()) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return false;
    }
    current = current[segment];
    if (index < path.length - 1 && !isObject(current)) {
      return true;
    }
  }
  return true;
}

export function parseAgentKHelmValues(
  raw: string | undefined,
  additionalCaFilePath?: string
): AgentKHelmValues {
  if (!raw || raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENTK_HELM_VALUES_JSON must be valid JSON');
  }
  if (!isObject(parsed)) {
    throw new Error('AGENTK_HELM_VALUES_JSON must be a JSON object');
  }

  for (const key of Object.keys(parsed)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(`AGENTK_HELM_VALUES_JSON contains an invalid top-level key: ${key}`);
    }
  }
  for (const path of RESERVED_VALUE_PATHS) {
    if (overridesReservedPath(parsed as AgentKHelmValues, path)) {
      throw new Error(`AGENTK_HELM_VALUES_JSON must not override control-plane-owned value ${path.join('.')}`);
    }
  }

  if (
    additionalCaFilePath &&
    overridesReservedPath(parsed as AgentKHelmValues, ['config', 'tls', 'additionalCaBundle'])
  ) {
    throw new Error(
      'AGENTK_HELM_VALUES_JSON must not configure config.tls.additionalCaBundle when AGENTK_HELM_ADDITIONAL_CA_FILE_PATH is set'
    );
  }

  return parsed as AgentKHelmValues;
}

export function validateAgentKHelmConfig(
  ctx: z.RefinementCtx,
  value: { AGENTK_HELM_VALUES_JSON?: string; AGENTK_HELM_ADDITIONAL_CA_FILE_PATH?: string }
): void {
  try {
    parseAgentKHelmValues(value.AGENTK_HELM_VALUES_JSON, value.AGENTK_HELM_ADDITIONAL_CA_FILE_PATH);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENTK_HELM_VALUES_JSON'],
      message: error instanceof Error ? error.message : 'Invalid AgentK Helm values configuration'
    });
  }
}
