import { EXAMPLE_VM_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const workspaceParam = {
  in: 'path',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const vmParam = {
  in: 'path',
  name: 'vmId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_VM_ID }
};

export function buildVirtualMachinePaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/virtual-machines': {
      get: {
        tags: ['workspaces'],
        summary: 'List virtual machines in a workspace',
        security: [{ userSession: [] }],
        parameters: [
          workspaceParam,
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'status', required: false, schema: { type: 'string' } }
        ],
        responses: { '200': { description: 'Virtual machine summary page payload: { items, nextCursor? }. Items include latestSnapshot.{targetId,workspaceId,timestamp} and summary.{inventoryCount,findingCount,criticalFindingCount,serviceCount,processCount,listenerCount,logCount}.' } }
      },
      post: {
        tags: ['workspaces'],
        summary: 'Register a Linux/systemd virtual machine and issue initial agent key',
        security: [{ userSession: [] }],
        parameters: [workspaceParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'payments-vm-01' },
                  hostname: { type: 'string', example: 'payments-vm-01.internal' },
                  osFamily: { type: 'string', enum: ['linux'], example: 'linux' },
                  serviceManager: { type: 'string', enum: ['systemd'], example: 'systemd' },
                  allowedLogSources: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['system', 'app', 'security']
                  }
                }
              }
            }
          }
        },
        responses: {
          '201': { description: 'VM registration created with systemd agent install instructions.' },
          '409': { description: 'Virtual machine quota exceeded. Returns QUOTA_EXCEEDED with quotaKey=virtualMachines.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}': {
      get: {
        tags: ['workspaces'],
        summary: 'Get virtual machine details and latest snapshot summary',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        responses: { '200': { description: 'VM details with latestSnapshot.{targetId,workspaceId,timestamp} and summary.{inventoryCount,findingCount,criticalFindingCount,serviceCount,processCount,listenerCount,logCount}.' } }
      },
      patch: {
        tags: ['workspaces'],
        summary: 'Update virtual machine metadata and allowed log sources',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'payments-vm-01' },
                  hostname: { type: 'string', example: 'payments-vm-01.internal' },
                  allowedLogSources: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['system', 'app']
                  }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'VM metadata updated.' } }
      },
      delete: {
        tags: ['workspaces'],
        summary: 'Delete a virtual machine target',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        responses: { '204': { description: 'VM target deleted.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/rotate-agent-key': {
      post: {
        tags: ['workspaces'],
        summary: 'Rotate the virtual machine agent key',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        responses: { '200': { description: 'Replacement VM agent key and updated systemd install instructions.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/resources': {
      get: {
        tags: ['workspaces'],
        summary: 'List snapshot-derived VM inventory items',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        responses: { '200': { description: 'VM inventory page payload: { items, nextCursor? }.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/metrics/history': {
      get: {
        tags: ['workspaces'],
        summary: 'Get bounded VM metrics history',
        security: [{ userSession: [] }],
        parameters: [
          workspaceParam,
          vmParam,
          { in: 'query', name: 'window', required: false, schema: { type: 'string', example: '1h' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 288, example: 48 } }
        ],
        responses: { '200': { description: 'VM load, memory, swap, and root disk history payload: { workspaceId, targetId, windowMs, points }.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/logs': {
      get: {
        tags: ['workspaces'],
        summary: 'Read bounded logs from the connected VM agent',
        security: [{ userSession: [] }],
        parameters: [
          workspaceParam,
          vmParam,
          { in: 'query', name: 'source', required: false, schema: { type: 'string', example: 'system' } },
          { in: 'query', name: 'query', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }
        ],
        responses: { '200': { description: 'VM log entries returned by the connected VM agent.' } }
      }
    }
  };
}
