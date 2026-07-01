import { EXAMPLE_TARGET_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

export function buildTargetToolPaths(): Record<string, unknown> {
  const targetParameters = [
    { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
    { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
  ];
  const entryParameters = [
    ...targetParameters,
    { in: 'path', name: 'entryId', required: true, schema: { type: 'string', format: 'uuid' } }
  ];
  const targetInsightsEntryRequestSchema = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['active', 'pending', 'archived'] },
      bodyMarkdown: { type: 'string' },
      frontmatter: { type: 'object', additionalProperties: true },
      tags: { type: 'array', items: { type: 'string' } },
      signals: { type: 'object', additionalProperties: true },
      scope: { type: 'object', additionalProperties: true },
      evidenceSummary: { type: 'string' },
      observationCount: { type: 'integer', minimum: 0 },
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    additionalProperties: false
  };
  const createTargetInsightsEntryRequestBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          ...targetInsightsEntryRequestSchema,
          required: ['title', 'status', 'bodyMarkdown']
        }
      }
    }
  };
  const updateTargetInsightsEntryRequestBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          ...targetInsightsEntryRequestSchema,
          minProperties: 1
        }
      }
    }
  };

  return {
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/tools': {
      get: {
        tags: ['workspaces'],
        summary: 'List built-in tools configured for a target',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        responses: {
          '200': { description: 'Target built-in tool catalog.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/assistant/capabilities-preview': {
      get: {
        tags: ['workspaces'],
        summary: 'Preview assistant capabilities available for a target run',
        description: 'Returns display-safe tools and assistant-visible skills for the requested run tool access mode. Execution bootstrap remains authoritative.',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          {
            in: 'query',
            name: 'toolAccessMode',
            required: true,
            schema: { type: 'string', enum: ['read_only', 'read_write'], example: 'read_only' }
          }
        ],
        responses: {
          '200': { description: 'Assistant capabilities preview for a target run.' },
          '400': { description: 'Invalid toolAccessMode or unsupported target type.' },
          '403': { description: 'Missing target access or run creation capability.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/{toolId}': {
      patch: {
        tags: ['workspaces'],
        summary: 'Update a built-in target tool',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'toolId', required: true, schema: { type: 'string', enum: ['web_search', 'target_insights'], example: 'web_search' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['enabled'],
                properties: {
                  enabled: { type: 'boolean', example: true },
                  config: { type: 'object', additionalProperties: true }
                },
                example: {
                  enabled: true,
                  config: {
                    domainFilters: {
                      allowedDomains: ['docs.example.com'],
                      blockedDomains: ['internal.example.com']
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Updated built-in target tool.' },
          '400': { description: 'Invalid tool configuration.' },
          '403': { description: 'Missing tool management or Target Insights management permission.' },
          '404': { description: 'Unknown toolId.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights': {
      get: {
        tags: ['workspaces'],
        summary: 'List Target Insights entries for a target',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        responses: {
          '200': { description: 'Target Insights entries and permissions for the target.' },
          '404': { description: 'Target Insights is disabled.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights/entries': {
      post: {
        tags: ['workspaces'],
        summary: 'Create a Target Insights entry for a target',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        requestBody: createTargetInsightsEntryRequestBody,
        responses: {
          '201': { description: 'Created Target Insights entry.' },
          '403': { description: 'Missing manage_target_insights permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights/entries/{entryId}': {
      patch: {
        tags: ['workspaces'],
        summary: 'Update a Target Insights entry',
        security: [{ userSession: [] }],
        parameters: entryParameters,
        requestBody: updateTargetInsightsEntryRequestBody,
        responses: {
          '200': { description: 'Updated Target Insights entry.' },
          '403': { description: 'Missing manage_target_insights permission.' },
          '404': { description: 'Target Insights entry not found.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights/entries/{entryId}/promote': {
      post: {
        tags: ['workspaces'],
        summary: 'Promote a Target Insights entry to active',
        security: [{ userSession: [] }],
        parameters: entryParameters,
        responses: {
          '200': { description: 'Promoted Target Insights entry.' },
          '403': { description: 'Missing manage_target_insights permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights/entries/{entryId}/archive': {
      post: {
        tags: ['workspaces'],
        summary: 'Archive a Target Insights entry',
        security: [{ userSession: [] }],
        parameters: entryParameters,
        responses: {
          '200': { description: 'Archived Target Insights entry.' },
          '403': { description: 'Missing manage_target_insights permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights/reset': {
      post: {
        tags: ['workspaces'],
        summary: 'Hard reset a target Target Insights',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        responses: {
          '200': { description: 'Deleted Target Insights entries and checkpoint jobs for the target.' },
          '403': { description: 'Missing manage_target_insights permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights/activity': {
      get: {
        tags: ['workspaces'],
        summary: 'List Target Insights audit activity for a target',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        responses: {
          '200': { description: 'Target Insights audit activity for the target.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/target-insights/export': {
      get: {
        tags: ['workspaces'],
        summary: 'Export target Target Insights as Markdown',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        responses: {
          '200': {
            description: 'OKF-style Markdown bundle.',
            content: {
              'text/markdown': {
                schema: { type: 'string' }
              }
            }
          }
        }
      }
    }
  };
}
