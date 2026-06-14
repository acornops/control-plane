import {
  EXAMPLE_CLUSTER_ID,
  EXAMPLE_WORKSPACE_ID
} from '../../constants/dev-defaults.js';

const workspaceRoleKeySchema = {
  type: 'string',
  pattern: '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$',
  description: 'Deployment-supported workspace role key. Built-ins are owner, admin, operator, viewer, and auditor; custom roles are lowercase snake_case.'
};

const llmProviderSchema = {
  type: 'string',
  enum: ['openai', 'anthropic', 'gemini']
};

export function buildWorkspacePaths(): Record<string, unknown> {
  return {
'/api/v1/workspaces': {
        get: {
          tags: ['workspaces'],
          summary: 'List workspaces available to current user',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Workspace page payload: { items, nextCursor? }. Workspace items include plan.{key,name} and quota.{members,kubernetesClusters,virtualMachines}.{used,limit}; operational quota usage is redacted to 0 when permissions.read_workspace_data is false, and member usage requires permissions.read_members.' } }
        },
        post: {
          tags: ['workspaces'],
          summary: 'Create a workspace',
          security: [{ userSession: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string', example: 'Production Platform' } },
                  example: { name: 'Production Platform' }
                }
              }
            }
          },
          responses: {
            '201': { description: 'Workspace created. Response includes plan.{key,name} and workspace quota.{members,kubernetesClusters,virtualMachines}.{used,limit}.' },
            '409': { description: 'Workspace membership quota exceeded. Returns QUOTA_EXCEEDED with quotaKey=workspaceMemberships.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}': {
        get: {
          tags: ['workspaces'],
          summary: 'Get a workspace summary available to current user',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            }
          ],
          responses: {
            '200': { description: 'Workspace summary, including plan.{key,name}, permissions, bounded list counts, and quota.{members,kubernetesClusters,virtualMachines}.{used,limit}. Operational counts and operational quota usage are redacted when permissions.read_workspace_data is false; member counts and quota usage require permissions.read_members.' },
            '404': { description: 'Workspace not found or not accessible.' }
          }
        },
        delete: {
          tags: ['workspaces'],
          summary: 'Delete a workspace (owner only)',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            }
          ],
          responses: {
            '204': { description: 'Workspace deleted.' },
            '403': { description: 'Only owners can delete workspace.' },
            '404': { description: 'Workspace not found.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/members': {
        get: {
          tags: ['workspaces'],
          summary: 'List workspace members',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'role', required: false, schema: workspaceRoleKeySchema },
            { in: 'query', name: 'source', required: false, schema: { type: 'string', enum: ['oidc', 'internal'] } }
          ],
          responses: { '200': { description: 'Workspace member page payload: { items, nextCursor? }.' } }
        },
        post: {
          tags: ['workspaces'],
          summary: 'Add a workspace member by email',
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
                  required: ['email', 'role'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'sre@example.com' },
                    displayName: { type: 'string', example: 'SRE User' },
                    role: workspaceRoleKeySchema
                  }
                }
              }
            }
          },
          responses: {
            '201': { description: 'Workspace member added. Response includes roleTemplate when the role is supported.' },
            '400': { description: 'ROLE_NOT_SUPPORTED when the role key is not in the deployment-supported catalog.' },
            '403': { description: 'Requires manage_members. PROTECTED_ROLE_REQUIRES_OWNER is returned when a non-owner assigns a protected role.' },
            '409': { description: 'User is already a member, user workspace-membership quota exceeded, or workspace member quota exceeded. Quota failures return QUOTA_EXCEEDED with quotaKey=workspaceMemberships or workspaceMembers.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/roles': {
        get: {
          tags: ['workspaces'],
          summary: 'List deployment-supported workspace role templates',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            }
          ],
          responses: {
            '200': {
              description: 'Deployment-supported role catalog: { items: RoleTemplate[] }. Role templates include key, displayName, description, kind, capabilities, protected, and sortOrder.'
            },
            '403': { description: 'No workspace read access.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/ai-settings': {
        get: {
          tags: ['workspaces'],
          summary: 'Get workspace AI assistant settings and provider credential status',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            }
          ],
          responses: {
            '200': { description: 'Workspace AI assistant settings. Response includes default provider/model, platform allow-lists, and configured/not-configured provider credential status. It never includes API key values or internal secret names.' },
            '403': { description: 'No workspace read access.' }
          }
        },
        patch: {
          tags: ['workspaces'],
          summary: 'Update workspace default AI provider, model, and reasoning summary settings',
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
                  required: ['defaultProvider', 'defaultModel'],
                  properties: {
                    defaultProvider: llmProviderSchema,
                    defaultModel: { type: 'string', example: 'gemini-2.0-flash' },
                    reasoningSummaryMode: { type: 'string', enum: ['off', 'auto', 'concise', 'detailed'], default: 'off' },
                    reasoningEffort: { type: 'string', enum: ['default', 'low', 'medium', 'high'], default: 'default' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Workspace AI assistant settings updated.' },
            '400': { description: 'Selected provider, model, reasoning summary mode, or effort is not allowed by deployment policy.' },
            '403': { description: 'Requires manage_ai_settings.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/ai-provider-credentials/{provider}': {
        put: {
          tags: ['workspaces'],
          summary: 'Save or rotate a workspace AI provider credential',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'provider', required: true, schema: llmProviderSchema }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['apiKey'],
                  properties: {
                    apiKey: { type: 'string', writeOnly: true, minLength: 1 }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Credential saved. Response returns safe AI settings status only, with no key value or secret name.' },
            '400': { description: 'Selected provider is not allowed by deployment policy.' },
            '403': { description: 'Requires manage_ai_settings.' }
          }
        },
        delete: {
          tags: ['workspaces'],
          summary: 'Delete a workspace AI provider credential',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'provider', required: true, schema: llmProviderSchema }
          ],
          responses: {
            '200': { description: 'Credential deleted. Response returns safe AI settings status only.' },
            '400': { description: 'Selected provider is not supported.' },
            '403': { description: 'Requires manage_ai_settings.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/audit-log': {
        get: {
          tags: ['workspaces'],
          summary: 'List workspace audit log events',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'category', required: false, schema: { type: 'string', enum: ['membership', 'workspace', 'target', 'session', 'run', 'approval', 'mcp', 'tool'] } },
            { in: 'query', name: 'eventType', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'actorUserId', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'objectType', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'from', required: false, schema: { type: 'string', format: 'date-time' } },
            { in: 'query', name: 'to', required: false, schema: { type: 'string', format: 'date-time' } }
          ],
          responses: {
            '200': { description: 'Workspace audit event page payload: { items, nextCursor? }. Events include operation=read|write.' },
            '400': { description: 'Invalid audit filter, blank string filter, date range, or cursor.' },
            '403': { description: 'Requires read_audit_log.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/invitations': {
        get: {
          tags: ['workspaces'],
          summary: 'List workspace invitations',
          security: [{ userSession: [] }],
          parameters: [
            {
              in: 'path',
              name: 'workspaceId',
              required: true,
              schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
            },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'role', required: false, schema: workspaceRoleKeySchema },
            { in: 'query', name: 'status', required: false, schema: { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] } }
          ],
          responses: {
            '200': { description: 'Workspace invitation page payload without raw tokens: { items, nextCursor? }.' },
            '403': { description: 'Requires manage_members.' }
          }
        },
        post: {
          tags: ['workspaces'],
          summary: 'Create a copyable workspace invitation link',
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
                  required: ['email', 'role'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'sre@example.com' },
                    role: workspaceRoleKeySchema,
                    expiresInDays: { type: 'integer', minimum: 1, maximum: 30, default: 7 }
                  }
                }
              }
            }
          },
          responses: {
            '201': { description: 'Invitation created. Response includes the raw token once and roleTemplate when the role is supported.' },
            '400': { description: 'ROLE_NOT_SUPPORTED when the role key is not in the deployment-supported catalog.' },
            '403': { description: 'Requires manage_members. PROTECTED_ROLE_REQUIRES_OWNER is returned when a non-owner assigns a protected role.' },
            '409': { description: 'User is already a member.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/invitations/{invitationId}': {
        delete: {
          tags: ['workspaces'],
          summary: 'Revoke a pending workspace invitation',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'invitationId', required: true, schema: { type: 'string', format: 'uuid' } }
          ],
          responses: {
            '200': { description: 'Invitation revoked.' },
            '403': { description: 'Requires manage_members.' },
            '404': { description: 'Invitation not found.' },
            '409': { description: 'Invitation is already accepted, revoked, or expired.' }
          }
        }
      },
      '/api/v1/workspace-invitations/{token}': {
        get: {
          tags: ['workspaces'],
          summary: 'Inspect a workspace invitation by token',
          parameters: [
            { in: 'path', name: 'token', required: true, schema: { type: 'string', example: 'wi_example' } }
          ],
          responses: {
            '200': { description: 'Invitation metadata without the raw token.' },
            '404': { description: 'Invitation not found.' }
          }
        }
      },
      '/api/v1/workspace-invitations/{token}/accept': {
        post: {
          tags: ['workspaces'],
          summary: 'Accept a workspace invitation as the signed-in matching user',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'token', required: true, schema: { type: 'string', example: 'wi_example' } }
          ],
          responses: {
            '200': { description: 'Invitation accepted and membership created.' },
            '403': { description: 'Signed-in user email does not match the invitation.' },
            '404': { description: 'Invitation not found.' },
            '410': { description: 'Invitation expired.' },
            '409': { description: 'User workspace-membership quota exceeded, or workspace member quota exceeded. Returns QUOTA_EXCEEDED with quotaKey=workspaceMemberships or workspaceMembers and leaves the invitation pending.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/investigations': {
        get: {
          tags: ['workspaces'],
          summary: 'List snapshot-derived investigations for a workspace',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'severity', required: false, schema: { type: 'string', enum: ['critical', 'warning', 'info'] } },
            { in: 'query', name: 'clusterId', required: false, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } },
            { in: 'query', name: 'namespace', required: false, schema: { type: 'string', example: 'default' } }
          ],
          responses: { '200': { description: 'Investigation page payload: { items, nextCursor? }.' } }
        }
      },
      '/api/v1/workspaces/{workspaceId}/members/{userId}': {
        patch: {
          tags: ['workspaces'],
          summary: 'Update a workspace member role',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'userId', required: true, schema: { type: 'string', format: 'uuid' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['role'],
                  properties: { role: workspaceRoleKeySchema }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Workspace member updated. Response includes roleTemplate when the role is supported.' },
            '400': { description: 'ROLE_NOT_SUPPORTED when the role key is not in the deployment-supported catalog.' },
            '403': { description: 'Role management denied. PROTECTED_ROLE_REQUIRES_OWNER is returned when a non-owner manages a protected role.' },
            '409': { description: 'Workspace must keep at least one owner.' }
          }
        },
        delete: {
          tags: ['workspaces'],
          summary: 'Remove a workspace member',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'userId', required: true, schema: { type: 'string', format: 'uuid' } }
          ],
          responses: {
            '204': { description: 'Workspace member removed.' },
            '403': { description: 'Role management denied.' },
            '409': { description: 'Workspace must keep at least one owner.' }
          }
        }
      },
  };
}
