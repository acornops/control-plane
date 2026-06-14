export function buildAdminPaths(): Record<string, unknown> {
  const adminSecurity = [{ adminBearer: [] }];
  const workspaceAuditSearchParameters = [
    { in: 'query', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid' } },
    { in: 'query', name: 'category', required: false, schema: { type: 'string' } },
    { in: 'query', name: 'eventType', required: false, schema: { type: 'string' } },
    { in: 'query', name: 'actorUserId', required: false, schema: { type: 'string' } },
    { in: 'query', name: 'objectType', required: false, schema: { type: 'string' } },
    { in: 'query', name: 'from', required: false, schema: { type: 'string', format: 'date-time' } },
    { in: 'query', name: 'to', required: false, schema: { type: 'string', format: 'date-time' } },
    { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
    { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }
  ];
  const mutationBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500 },
            ticketRef: { type: 'string' }
          }
        }
      }
    }
  };
  return {
    '/admin/v1/me': {
      get: {
        tags: ['admin'],
        summary: 'Inspect the current admin token',
        security: adminSecurity,
        responses: { '200': { description: 'Admin token id, optional name, scopes, and enabled status.' } }
      }
    },
    '/admin/v1/system/readiness': {
      get: {
        tags: ['admin'],
        summary: 'Read admin readiness',
        security: adminSecurity,
        responses: { '200': { description: 'Sanitized readiness details.' }, '503': { description: 'Dependency degraded.' } }
      }
    },
    '/admin/v1/system/config': {
      get: {
        tags: ['admin'],
        summary: 'Read sanitized admin-relevant config',
        security: adminSecurity,
        responses: { '200': { description: 'Secret-redacted effective config.' } }
      }
    },
    '/admin/v1/workspaces': {
      get: {
        tags: ['admin'],
        summary: 'Search all workspaces',
        security: adminSecurity,
        responses: { '200': { description: 'Paged workspace support summaries.' } }
      }
    },
    '/admin/v1/workspaces/{workspaceId}': {
      get: {
        tags: ['admin'],
        summary: 'Get workspace support detail',
        security: adminSecurity,
        responses: { '200': { description: 'Safe workspace detail.' }, '404': { description: 'Workspace not found.' } }
      }
    },
    '/admin/v1/workspaces/{workspaceId}/plan': {
      patch: {
        tags: ['admin'],
        summary: 'Change workspace plan',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'Plan changed with before/after data.' }, '400': { description: 'Invalid plan or current usage exceeds target plan.' } }
      }
    },
    '/admin/v1/workspaces/{workspaceId}/quotas': {
      patch: {
        tags: ['admin'],
        summary: 'Set or clear workspace quota overrides',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'Quota overrides changed.' } }
      }
    },
    '/admin/v1/users': {
      get: {
        tags: ['admin'],
        summary: 'Search users',
        security: adminSecurity,
        responses: { '200': { description: 'Paged safe user summaries.' } }
      }
    },
    '/admin/v1/users/{userId}': {
      get: {
        tags: ['admin'],
        summary: 'Get safe user support detail',
        security: adminSecurity,
        responses: { '200': { description: 'Safe user detail without password hashes or reset tokens.' } }
      }
    },
    '/admin/v1/users/{userId}/sessions/revoke': {
      post: {
        tags: ['admin'],
        summary: 'Revoke browser sessions for a user',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'Session revocation result.' } }
      }
    },
    '/admin/v1/workspaces/{workspaceId}/members': {
      post: {
        tags: ['admin'],
        summary: 'Break-glass add workspace member',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '201': { description: 'Membership created.' } }
      }
    },
    '/admin/v1/workspaces/{workspaceId}/members/{userId}/role': {
      patch: {
        tags: ['admin'],
        summary: 'Break-glass update workspace member role',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'Membership role updated.' }, '409': { description: 'Last-owner invariant would be violated.' } }
      }
    },
    '/admin/v1/workspaces/{workspaceId}/members/{userId}': {
      delete: {
        tags: ['admin'],
        summary: 'Break-glass remove workspace member',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '204': { description: 'Membership removed.' }, '409': { description: 'Last-owner invariant would be violated.' } }
      }
    },
    '/admin/v1/targets': {
      get: {
        tags: ['admin'],
        summary: 'Search targets across workspaces',
        security: adminSecurity,
        responses: { '200': { description: 'Paged safe target summaries.' } }
      }
    },
    '/admin/v1/targets/{targetId}/agent': {
      get: {
        tags: ['admin'],
        summary: 'Get safe target agent detail',
        security: adminSecurity,
        responses: { '200': { description: 'Agent detail without key hashes.' } }
      }
    },
    '/admin/v1/targets/{targetId}/agent/disconnect': {
      post: {
        tags: ['admin'],
        summary: 'Force target agent reconnect',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'Disconnect result.' } }
      }
    },
    '/admin/v1/targets/{targetId}/agent-key/rotate': {
      post: {
        tags: ['admin'],
        summary: 'Emergency rotate a target agent key',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'One-time agent key and install instructions.' } }
      }
    },
    '/admin/v1/runs': {
      get: {
        tags: ['admin'],
        summary: 'Search runs across workspaces',
        security: adminSecurity,
        responses: { '200': { description: 'Paged safe run summaries without prompts or message bodies.' } }
      }
    },
    '/admin/v1/runs/{runId}': {
      get: {
        tags: ['admin'],
        summary: 'Get safe run detail',
        security: adminSecurity,
        responses: { '200': { description: 'Safe run detail without prompt or full tool argument content.' } }
      }
    },
    '/admin/v1/runs/{runId}/cancel': {
      post: {
        tags: ['admin'],
        summary: 'Cancel a run without workspace membership',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '202': { description: 'Cancellation accepted.' } }
      }
    },
    '/admin/v1/runs/{runId}/mark-failed': {
      post: {
        tags: ['admin'],
        summary: 'Break-glass terminalize a stuck run as failed',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'Run marked failed.' }, '409': { description: 'Run appears active and force was not set.' } }
      }
    },
    '/admin/v1/tooling/sync': {
      post: {
        tags: ['admin'],
        summary: 'Reconcile built-in tooling',
        security: adminSecurity,
        requestBody: mutationBody,
        responses: { '200': { description: 'Sync result.' }, '207': { description: 'Partial sync failure.' } }
      }
    },
    '/admin/v1/admin-audit-events': {
      get: {
        tags: ['admin'],
        summary: 'Search admin audit events',
        security: adminSecurity,
        responses: { '200': { description: 'Paged admin audit events.' } }
      }
    },
    '/admin/v1/audit-events': {
      get: {
        tags: ['admin'],
        summary: 'Search workspace audit events across workspaces',
        security: adminSecurity,
        parameters: workspaceAuditSearchParameters,
        responses: { '200': { description: 'Paged sanitized workspace audit events.' } }
      }
    }
  };
}
