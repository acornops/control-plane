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

const externalUserHeader = {
  in: 'header',
  name: 'x-acornops-external-user-id',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 128 },
  description: 'Required only for external integration client-token requests. Must identify a linked external integration user.'
};

export function buildVirtualMachinePaths(): Record<string, unknown> {
  return {
    '/api/v1/agentv/enrollments/exchange': {
      post: {
        tags: ['agents'],
        summary: 'Exchange a one-use AgentV enrollment token for a pending credential',
        description: 'Called only by the root AgentV installer. The token is target-bound, expires after 15 minutes, and is consumed atomically.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['targetId', 'enrollmentToken', 'purpose'], additionalProperties: false,
            properties: {
              targetId: { type: 'string', minLength: 1, maxLength: 128 },
              enrollmentToken: { type: 'string', minLength: 84, maxLength: 84, writeOnly: true },
              purpose: { type: 'string', enum: ['initial', 'replace'] }
            }
          } } }
        },
        responses: { '200': { description: 'Pending credential and protected installation transaction created.' } }
      }
    },
    '/api/v1/agentv/installations/{transactionId}/status': {
      get: {
        tags: ['agents'], summary: 'Read an AgentV installation transaction status',
        description: 'Root-installer recovery endpoint. The protected status remains readable after the one-hour mutation window so an interrupted host can resolve a final completed, cancelled, or expired state.',
        security: [],
        parameters: [{ in: 'path', name: 'transactionId', required: true, schema: { type: 'string', format: 'uuid' } }, {
          in: 'header', name: 'x-agentv-transaction-secret', required: true,
          schema: { type: 'string', minLength: 73, maxLength: 73, pattern: '^avt_[0-9a-fA-F-]{36}_[0-9a-fA-F]{32}$', writeOnly: true }
        }],
        responses: { '200': { description: 'Authenticated installation transaction status.' } }
      }
    },
    '/api/v1/agentv/installations/{transactionId}/commit': {
      post: {
        tags: ['agents'], summary: 'Commit a verified AgentV installation transaction',
        description: 'Requires provisional authentication and the protected transaction secret within its one-hour mutation window.', security: [],
        parameters: [{ in: 'path', name: 'transactionId', required: true, schema: { type: 'string', format: 'uuid' } }, {
          in: 'header', name: 'x-agentv-transaction-secret', required: true,
          schema: { type: 'string', minLength: 73, maxLength: 73, pattern: '^avt_[0-9a-fA-F-]{36}_[0-9a-fA-F]{32}$', writeOnly: true }
        }],
        responses: { '200': { description: 'Pending credential promoted to active.' } }
      }
    },
    '/api/v1/agentv/installations/{transactionId}/rollback': {
      post: {
        tags: ['agents'], summary: 'Roll back an AgentV installation transaction',
        description: 'Requires the protected transaction secret within its one-hour mutation window. A committed replacement can restore the prior credential only during its 30-minute grace period.', security: [],
        parameters: [{ in: 'path', name: 'transactionId', required: true, schema: { type: 'string', format: 'uuid' } }, {
          in: 'header', name: 'x-agentv-transaction-secret', required: true,
          schema: { type: 'string', minLength: 73, maxLength: 73, pattern: '^avt_[0-9a-fA-F-]{36}_[0-9a-fA-F]{32}$', writeOnly: true }
        }],
        responses: { '200': { description: 'Candidate revoked and the prior credential restored when available.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines': {
      get: {
        tags: ['workspaces'],
        summary: 'List virtual machines in a workspace',
        description: 'Browser callers use the session cookie. External integration callers may use the external integration client token plus x-acornops-external-user-id when the linked user and bot allowlist grant read_workspace_data.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [
          externalUserHeader,
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
        summary: 'Register a Linux/systemd virtual machine and issue a one-use AgentV enrollment command',
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
                  },
                  agentAccessMode: { type: 'string', enum: ['read_only', 'read_write'], default: 'read_only' },
                  restartServices: {
                    type: 'array',
                    maxItems: 32,
                    uniqueItems: true,
                    items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}\\.service$' },
                    example: ['nginx.service']
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
        description: 'Browser callers use the session cookie. External integration callers may use the external integration client token plus x-acornops-external-user-id when the linked user and bot allowlist grant read_workspace_data.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, workspaceParam, vmParam],
        responses: { '200': { description: 'VM details with latestSnapshot.{targetId,workspaceId,timestamp} and summary.{inventoryCount,findingCount,criticalFindingCount,serviceCount,processCount,listenerCount,logCount}.' } }
      },
      patch: {
        tags: ['workspaces'],
        summary: 'Update virtual machine metadata and run permission policy',
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
                  },
                  permissionModeOverride: {
                    type: ['string', 'null'],
                    enum: ['read_only', 'ask_before_changes', 'auto_allowed_changes', null],
                    description: 'VM-specific assistant run policy. Null restores the deployment default.'
                  }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'VM metadata and effective permission policy updated.' } }
      },
      delete: {
        tags: ['workspaces'],
        summary: 'Delete a virtual machine target',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        responses: {
          '204': { description: 'VM target deleted.' },
          '503': { description: 'Gateway lifecycle teardown is incomplete; the VM remains locally present and deletion can be retried.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/agent-enrollments': {
      post: {
        tags: ['workspaces'],
        summary: 'Issue an initial or replacement AgentV enrollment command',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['purpose'],
                additionalProperties: false,
                properties: { purpose: { type: 'string', enum: ['initial', 'replace'] } }
              }
            }
          }
        },
        responses: { '200': { description: 'One-use AgentV enrollment command; the active credential is unchanged.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/agent-access-policy-updates': {
      post: {
        tags: ['workspaces'],
        summary: 'Create a transactional AgentV host access policy update',
        description: 'Returns a one-use root command. The applied host policy remains unchanged and VM writes remain disabled until the command commits successfully.',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['agentAccessMode', 'restartServices'],
                additionalProperties: false,
                properties: {
                  agentAccessMode: { type: 'string', enum: ['read_only', 'read_write'] },
                  restartServices: {
                    type: 'array', maxItems: 32, uniqueItems: true,
                    items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}\\.service$' }
                  }
                }
              }
            }
          }
        },
        responses: {
          '201': { description: 'Pending host policy and one-use application command.' },
          '409': { description: 'AgentV is not enrolled, the policy is already applied, or credential state changed.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/install-instructions': {
      post: {
        tags: ['workspaces'],
        summary: 'Generate credential-free AgentV upgrade or repair instructions',
        security: [{ userSession: [] }],
        parameters: [workspaceParam, vmParam],
        responses: {
          '200': { description: 'Pinned instructions that reuse the matching VM credential.' },
          '409': { description: 'AgentV has no active credential; initial enrollment is required.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/virtual-machines/{vmId}/resources': {
      get: {
        tags: ['workspaces'],
        summary: 'List snapshot-derived VM inventory items',
        description: 'Browser callers use the session cookie. External integration callers may use the external integration client token plus x-acornops-external-user-id when the linked user and bot allowlist grant read_workspace_data.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, workspaceParam, vmParam],
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
        summary: 'Read bounded logs from the connected AgentV',
        security: [{ userSession: [] }],
        parameters: [
          workspaceParam,
          vmParam,
          { in: 'query', name: 'source', required: false, schema: { type: 'string', example: 'system' } },
          { in: 'query', name: 'query', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }
        ],
        responses: { '200': { description: 'VM log entries returned by the connected AgentV.' } }
      }
    }
  };
}
