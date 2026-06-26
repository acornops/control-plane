import { EXAMPLE_CLUSTER_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const metricPointSchema = {
  type: 'object',
  required: ['timestamp', 'cpuCores', 'memoryBytes'],
  properties: {
    timestamp: { type: 'string', format: 'date-time' },
    cpuCores: { type: 'number', nullable: true },
    memoryBytes: { type: 'number', nullable: true }
  }
};

export function buildClusterMetricPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/metrics/history': {
      get: {
        tags: ['workspaces'],
        summary: 'List compact telemetry history for multiple clusters',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'query', name: 'clusterIds', required: false, schema: { type: 'string', example: EXAMPLE_CLUSTER_ID }, description: 'Comma-separated cluster IDs. At most 20 IDs are processed.' },
          { in: 'query', name: 'window', required: false, schema: { type: 'string', example: '1h' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 288, example: 48 } }
        ],
        responses: {
          '200': {
            description: 'Cluster CPU and memory history grouped by cluster ID.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['workspaceId', 'windowMs', 'items'],
                  properties: {
                    workspaceId: { type: 'string', format: 'uuid' },
                    windowMs: { type: 'integer' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['clusterId', 'points'],
                        properties: {
                          clusterId: { type: 'string', format: 'uuid' },
                          points: { type: 'array', items: metricPointSchema }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/metrics/history': {
      get: {
        tags: ['workspaces'],
        summary: 'List compact cluster telemetry history',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } },
          { in: 'query', name: 'window', required: false, schema: { type: 'string', example: '1h' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 288, example: 48 } }
        ],
        responses: {
          '200': {
            description: 'Cluster CPU and memory history derived from compact metric samples.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['workspaceId', 'clusterId', 'windowMs', 'points'],
                  properties: {
                    workspaceId: { type: 'string', format: 'uuid' },
                    clusterId: { type: 'string', format: 'uuid' },
                    windowMs: { type: 'integer' },
                    points: { type: 'array', items: metricPointSchema }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}
