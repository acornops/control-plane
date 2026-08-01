import type { TargetType } from '../types/domain.js';
import { TARGETS_MCP_SERVER_ID } from './targets-mcp.js';

export interface TargetsMcpCatalogTool {
  name: string;
  description: string;
  capability: 'read' | 'write';
  targetTypes: TargetType[];
  inputSchema: Record<string, unknown>;
}

const string = (options: Record<string, unknown> = {}) => ({ type: 'string', ...options });
const integer = (options: Record<string, unknown> = {}) => ({ type: 'integer', ...options });
const boolean = { type: 'boolean' };
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });
const enumString = (values: string[]) => string({ enum: values });
const kubernetesName = string({ minLength: 1, maxLength: 253 });
const namespace = string({ minLength: 1, maxLength: 63 });
const reason = string({ minLength: 1, maxLength: 512 });
const customResourceIdentity = {
  addition_key: string({ minLength: 1, maxLength: 64 }),
  resource: string({ minLength: 1, maxLength: 253 }),
  namespace
};
const serviceUnit = string({
  minLength: 9,
  maxLength: 263,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}\\.service$'
});
const guardedChanges = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  items: {
    type: 'object',
    description: 'A connector-validated semantic change. Inspect the target first and use its exact preconditions.'
  }
};

const kubernetesTools: TargetsMcpCatalogTool[] = [
  {
    name: 'list_resources',
    description: 'List Kubernetes resources by kind with optional namespace and selector filters. Omit namespace to query all allowed namespaces and follow continue_token until it is empty for a complete listing.',
    capability: 'read',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      kind: enumString(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Service', 'Ingress', 'ConfigMap', 'PVC', 'HPA', 'Namespace', 'Node', 'Event']),
      namespace,
      label_selector: string({ maxLength: 1024 }),
      field_selector: string({ maxLength: 1024 }),
      limit: integer({ minimum: 1, maximum: 1000 }),
      continue_token: string({ maxLength: 4096 })
    }, ['kind'])
  },
  {
    name: 'get_resource_logs',
    description: 'Read logs from a Kubernetes Pod container with bounded tail and time-range controls.',
    capability: 'read',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      name: kubernetesName,
      namespace,
      container: string({ minLength: 1, maxLength: 63 }),
      previous: boolean,
      tail_lines: integer({ minimum: 1, maximum: 5000 }),
      since_seconds: integer({ minimum: 1 }),
      limit_bytes: integer({ minimum: 1, maximum: 1_048_576 })
    }, ['name', 'namespace'])
  },
  {
    name: 'get_resource',
    description: 'Fetch one exact Kubernetes resource. Use the returned UID, resourceVersion, ownership path, and remediation target as write preconditions; never guess a controller identity.',
    capability: 'read',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      kind: enumString(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Service', 'Ingress', 'ConfigMap', 'PVC', 'Node', 'HPA', 'Event', 'Namespace']),
      name: kubernetesName,
      namespace
    }, ['kind', 'name'])
  },
  {
    name: 'list_custom_resources',
    description: 'List a custom-resource type from an administrator-approved integration. Use only addition and resource keys exposed by the installed AgentK configuration.',
    capability: 'read',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      ...customResourceIdentity,
      label_selector: string({ maxLength: 1024 }),
      field_selector: string({ maxLength: 1024 }),
      limit: integer({ minimum: 1, maximum: 50 }),
      continue_token: string({ maxLength: 4096 })
    }, ['addition_key', 'resource'])
  },
  {
    name: 'get_custom_resource',
    description: 'Fetch one exact custom resource from an administrator-approved integration.',
    capability: 'read',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      ...customResourceIdentity,
      name: kubernetesName
    }, ['addition_key', 'resource', 'name'])
  },
  {
    name: 'watch_custom_resources',
    description: 'Watch bounded changes to an administrator-approved custom-resource type.',
    capability: 'read',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      ...customResourceIdentity,
      label_selector: string({ maxLength: 1024 }),
      field_selector: string({ maxLength: 1024 }),
      resource_version: string({ minLength: 1, maxLength: 128 }),
      timeout_seconds: integer({ minimum: 1, maximum: 30 }),
      limit: integer({ minimum: 1, maximum: 50 })
    }, ['addition_key', 'resource'])
  },
  {
    name: 'restart_workload',
    description: 'Trigger an approval-gated rolling restart for one exact Kubernetes workload.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      kind: enumString(['Deployment', 'StatefulSet', 'DaemonSet']),
      name: kubernetesName,
      namespace,
      reason
    }, ['kind', 'name', 'namespace', 'reason'])
  },
  {
    name: 'scale_workload',
    description: 'Scale one exact Kubernetes Deployment or StatefulSet to a guarded replica count.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      kind: enumString(['Deployment', 'StatefulSet']),
      name: kubernetesName,
      namespace,
      replicas: integer({ minimum: 0, maximum: 100 }),
      reason,
      confirm_scale_to_zero: boolean,
      confirm_hpa_override: boolean,
      expected_current_replicas: integer({ minimum: 0 })
    }, ['kind', 'name', 'namespace', 'replicas', 'reason'])
  },
  {
    name: 'patch_workload',
    description: 'Apply bounded semantic changes to an exact Kubernetes workload after get_resource. Requires exact identity and resource-version preconditions.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      kind: enumString(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']),
      namespace,
      name: kubernetesName,
      expected_uid: string({ minLength: 1, maxLength: 128 }),
      expected_resource_version: string({ minLength: 1, maxLength: 128 }),
      reason,
      confirm_non_secret_data: boolean,
      changes: guardedChanges
    }, ['kind', 'namespace', 'name', 'expected_uid', 'expected_resource_version', 'reason', 'changes'])
  },
  {
    name: 'patch_resource',
    description: 'Apply bounded semantic metadata or explicitly enabled selector changes to an exact Kubernetes Service or Ingress after get_resource.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      kind: enumString(['Service', 'Ingress']),
      namespace,
      name: kubernetesName,
      expected_uid: string({ minLength: 1, maxLength: 128 }),
      expected_resource_version: string({ minLength: 1, maxLength: 128 }),
      reason,
      confirm_service_selector_change: boolean,
      changes: guardedChanges
    }, ['kind', 'namespace', 'name', 'expected_uid', 'expected_resource_version', 'reason', 'changes'])
  },
  {
    name: 'patch_configmap',
    description: 'Set or remove bounded non-secret ConfigMap data keys after get_resource. Requires exact identity and resource-version preconditions.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      namespace,
      name: kubernetesName,
      expected_uid: string({ minLength: 1, maxLength: 128 }),
      expected_resource_version: string({ minLength: 1, maxLength: 128 }),
      reason,
      confirm_non_secret_data: { const: true },
      changes: guardedChanges
    }, ['namespace', 'name', 'expected_uid', 'expected_resource_version', 'reason', 'confirm_non_secret_data', 'changes'])
  },
  {
    name: 'create_custom_resource',
    description: 'Create one custom resource from an administrator-approved integration.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      ...customResourceIdentity,
      body: { type: 'object', additionalProperties: true },
      reason
    }, ['addition_key', 'resource', 'body', 'reason'])
  },
  {
    name: 'patch_custom_resource',
    description: 'Patch /spec fields on one exact administrator-approved custom resource. Requires identity from list_custom_resources, read/write access, and normal write approval.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      ...customResourceIdentity,
      name: kubernetesName,
      expected_uid: string({ minLength: 1, maxLength: 128 }),
      expected_resource_version: string({ minLength: 1, maxLength: 128 }),
      reason,
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: objectSchema({
          op: enumString(['add', 'replace', 'remove']),
          path: string({
            minLength: 6,
            maxLength: 512,
            pattern: '^/spec(?:/[^/~]*(?:~[01][^/~]*)*)+$'
          }),
          value: {}
        }, ['op', 'path'])
      }
    }, [
      'addition_key', 'resource', 'name', 'expected_uid',
      'expected_resource_version', 'reason', 'operations'
    ])
  },
  {
    name: 'delete_custom_resource',
    description: 'Delete one exact custom resource from an administrator-approved integration.',
    capability: 'write',
    targetTypes: ['kubernetes'],
    inputSchema: objectSchema({
      ...customResourceIdentity,
      name: kubernetesName,
      expected_uid: string({ minLength: 1, maxLength: 128 }),
      expected_resource_version: string({ minLength: 1, maxLength: 128 }),
      reason
    }, [
      'addition_key', 'resource', 'name', 'expected_uid',
      'expected_resource_version', 'reason'
    ])
  }
];

const virtualMachineTools: TargetsMcpCatalogTool[] = [
  {
    name: 'get_host_summary',
    description: 'Return bounded Linux host identity, load, CPU, memory, swap, pressure availability, and collector health.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({})
  },
  {
    name: 'list_filesystems',
    description: 'List bounded mounted filesystem byte and inode capacity with read-only state.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({
      mount: string({ minLength: 1, maxLength: 4096 }),
      include_pseudo: boolean,
      limit: integer({ minimum: 1, maximum: 100 })
    })
  },
  {
    name: 'list_processes',
    description: 'List bounded redacted Linux process summaries with exact sorting and filters.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({
      sort_by: enumString(['cpu', 'memory', 'pid', 'start_time']),
      order: enumString(['asc', 'desc']),
      user: string({ minLength: 1, maxLength: 128 }),
      query: string({ minLength: 1, maxLength: 256 }),
      limit: integer({ minimum: 1, maximum: 100 })
    })
  },
  {
    name: 'get_process',
    description: 'Get one exact Linux process by positive PID without collecting environment variables.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({ pid: integer({ minimum: 1 }) }, ['pid'])
  },
  {
    name: 'list_services',
    description: 'List bounded systemd service summaries by state and query.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({
      state: enumString(['all', 'active', 'failed', 'inactive']),
      query: string({ minLength: 1, maxLength: 256 }),
      limit: integer({ minimum: 1, maximum: 200 })
    })
  },
  {
    name: 'get_service',
    description: 'Get one exact systemd service and capability-safe restart preconditions.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({ unit: serviceUnit }, ['unit'])
  },
  {
    name: 'query_logs',
    description: 'Query bounded normalized journald entries from locally allowed systemd service units.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({
      unit: serviceUnit,
      priority: integer({ minimum: 0, maximum: 7 }),
      since: string({ format: 'date-time' }),
      until: string({ format: 'date-time' }),
      query: string({ minLength: 1, maxLength: 512 }),
      cursor: string({ minLength: 1, maxLength: 4096 }),
      limit: integer({ minimum: 1, maximum: 500 }),
      byte_limit: integer({ minimum: 1024, maximum: 1_048_576 })
    })
  },
  {
    name: 'list_listeners',
    description: 'List bounded TCP or UDP listeners with partial ownership represented explicitly.',
    capability: 'read',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({
      protocol: enumString(['tcp', 'udp']),
      port: integer({ minimum: 1, maximum: 65_535 }),
      address: string({ minLength: 1, maxLength: 256 }),
      process_query: string({ minLength: 1, maxLength: 256 }),
      limit: integer({ minimum: 1, maximum: 200 })
    })
  },
  {
    name: 'restart_service',
    description: 'Restart one exact locally allowlisted systemd service after checking supplied preconditions.',
    capability: 'write',
    targetTypes: ['virtual_machine'],
    inputSchema: objectSchema({
      unit: serviceUnit,
      reason,
      expected_active_state: string({ minLength: 1, maxLength: 64 }),
      expected_sub_state: string({ minLength: 1, maxLength: 64 }),
      expected_invocation_id: string({ minLength: 1, maxLength: 128 })
    }, ['unit', 'reason', 'expected_active_state', 'expected_sub_state'])
  }
];

export const TARGETS_MCP_CATALOG: readonly TargetsMcpCatalogTool[] = Object.freeze([
  ...kubernetesTools,
  ...virtualMachineTools
]);

export function targetsMcpToolRefs(capability: 'read' | 'write') {
  return TARGETS_MCP_CATALOG
    .filter((tool) => tool.capability === capability)
    .map((tool) => ({
      serverId: TARGETS_MCP_SERVER_ID,
      toolName: tool.name,
      alias: tool.name,
      operation: capability
    }));
}
