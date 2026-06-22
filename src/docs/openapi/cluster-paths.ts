import { EXAMPLE_CLUSTER_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';
import { buildClusterMetricPaths } from './cluster-metric-paths.js';

const externalUserHeader = {
  in: 'header',
  name: 'x-acornops-external-user-id',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 128 },
  description: 'Required only for external integration service-token requests. Must identify a linked external integration user.'
};

export function buildClusterPaths(): Record<string, unknown> {
  return {
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/tools/catalog': {
        get: {
          tags: ['workspaces'],
          summary: 'List cluster tools grouped by server with configured/effective state',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            },
            {
              in: 'path',
              name: 'clusterId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID }
            },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Cluster tool catalog grouped by paged server summaries.' } }
        }
      },
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters': {
        get: {
          tags: ['workspaces'],
          summary: 'List clusters in a workspace',
          description: 'Browser callers use the session cookie. Phase-1 external integration callers may use the external integration service token plus x-acornops-external-user-id for a linked external user with bot-scoped read_workspace_data.',
          security: [{ userSession: [] }, { externalIntegrationServiceToken: [] }],
          parameters: [
            externalUserHeader,
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'status', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'agentState', required: false, schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Cluster summary page payload: { items, nextCursor? }.' } }
        },
        post: {
          tags: ['workspaces'],
          summary: 'Register a cluster and issue initial agent key',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', example: 'payments-prod-eks' },
                    namespaceInclude: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['payments', 'shared']
                    },
                    namespaceExclude: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['sandbox']
                    }
                  },
                  example: {
                    name: 'payments-prod-eks',
                    namespaceInclude: ['payments', 'shared'],
                    namespaceExclude: ['sandbox']
                  }
                }
              }
            }
          },
          responses: {
            '201': { description: 'Cluster registration created with agent install instructions.' },
            '409': { description: 'Kubernetes cluster quota exceeded. Returns QUOTA_EXCEEDED with quotaKey=kubernetesClusters.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}': {
        get: {
          tags: ['workspaces'],
          summary: 'Get cluster details and latest snapshot summary',
          description: 'Browser callers use the session cookie. External integration callers may use the external integration service token plus x-acornops-external-user-id when the linked user and bot allowlist grant read_workspace_data.',
          security: [{ userSession: [] }, { externalIntegrationServiceToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } }
          ],
          responses: { '200': { description: 'Cluster details with latestSnapshot timestamp and summary counts, without full snapshot data.' } }
        },
        patch: {
          tags: ['workspaces'],
          summary: 'Update cluster metadata, namespace scope, and write confirmation policy',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', example: 'payments-prod-eks' },
                    namespaceInclude: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['payments', 'shared']
                    },
                    namespaceExclude: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['sandbox']
                    },
                    writeConfirmationRequiredOverride: {
                      type: ['boolean', 'null'],
                      description: 'Per-cluster write confirmation override. Use null to inherit the deployment default.',
                      example: true
                    }
                  },
                  example: {
                    name: 'payments-prod-eks',
                    namespaceInclude: ['payments', 'shared'],
                    namespaceExclude: ['sandbox'],
                    writeConfirmationRequiredOverride: null
                  }
                }
              }
            }
          },
          responses: { '200': { description: 'Cluster updated.' } }
        },
        delete: {
          tags: ['workspaces'],
          summary: 'Delete cluster (requires target management capability)',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } }
          ],
          responses: {
            '204': { description: 'Cluster deleted.' },
            '403': { description: 'Requires manage_targets.' },
            '404': { description: 'Cluster not found.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/resources': {
        get: {
          tags: ['workspaces'],
          summary: 'List snapshot-derived cluster resources',
          description: 'Browser callers use the session cookie. External integration callers may use the external integration service token plus x-acornops-external-user-id when the linked user and bot allowlist grant read_workspace_data.',
          security: [{ userSession: [] }, { externalIntegrationServiceToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'family', required: false, schema: { type: 'string', enum: ['workloads', 'network', 'storage', 'cluster'] } },
            { in: 'query', name: 'kind', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'namespace', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'health', required: false, schema: { type: 'string', enum: ['healthy', 'attention'] } }
          ],
          responses: { '200': { description: 'Cluster resource page payload: { items, nextCursor? }.' } }
        }
      },
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/findings': {
        get: {
          tags: ['workspaces'],
          summary: 'List snapshot-derived cluster findings',
          description: 'Browser callers use the session cookie. External integration callers may use the external integration service token plus x-acornops-external-user-id when the linked user and bot allowlist grant read_workspace_data.',
          security: [{ userSession: [] }, { externalIntegrationServiceToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'severity', required: false, schema: { type: 'string', enum: ['critical', 'warning', 'info'] } },
            { in: 'query', name: 'namespace', required: false, schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Cluster finding page payload: { items, nextCursor? }.' } }
        }
      },
      ...buildClusterMetricPaths(),
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/pods/{namespace}/{podName}/logs': {
        get: {
          tags: ['workspaces'],
          summary: 'Read pod logs through the connected Kubernetes agent',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } },
            { in: 'path', name: 'namespace', required: true, schema: { type: 'string', example: 'default' } },
            { in: 'path', name: 'podName', required: true, schema: { type: 'string', example: 'web-7d9f6db7d5-z2mwr' } },
            { in: 'query', name: 'container', required: false, schema: { type: 'string', example: 'web' } },
            { in: 'query', name: 'tailLines', required: false, schema: { type: 'integer', minimum: 1, maximum: 5000, default: 200 } },
            { in: 'query', name: 'previous', required: false, schema: { type: 'boolean', default: false } },
            { in: 'query', name: 'sinceSeconds', required: false, schema: { type: 'integer', minimum: 1 } },
            { in: 'query', name: 'limitBytes', required: false, schema: { type: 'integer', minimum: 1, maximum: 10485760, default: 1048576 } }
          ],
          responses: {
            '200': { description: 'Pod logs payload.' },
            '403': { description: 'Only operators/admins/owners can read pod logs, and only within the cluster namespace scope.' },
            '503': { description: 'Agent is not connected or timed out.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/rotate-agent-key': {
        post: {
          tags: ['workspaces'],
          summary: 'Rotate cluster agent key',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } }
          ],
          responses: { '200': { description: 'New key and agent install instructions issued.' } }
        }
      },
  };
}
