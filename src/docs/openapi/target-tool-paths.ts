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
  const knowledgeEntryRequestSchema = {
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
  const createKnowledgeEntryRequestBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          ...knowledgeEntryRequestSchema,
          required: ['title', 'status', 'bodyMarkdown']
        }
      }
    }
  };
  const updateKnowledgeEntryRequestBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          ...knowledgeEntryRequestSchema,
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
          { in: 'path', name: 'toolId', required: true, schema: { type: 'string', enum: ['web_search', 'knowledge_bank'], example: 'web_search' } }
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
          '403': { description: 'Missing tool management or Knowledge Bank management permission.' },
          '404': { description: 'Unknown toolId.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank': {
      get: {
        tags: ['workspaces'],
        summary: 'List Knowledge Bank entries for a target',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        responses: {
          '200': { description: 'Knowledge Bank entries and permissions for the target.' },
          '404': { description: 'Knowledge Bank is disabled.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank/entries': {
      post: {
        tags: ['workspaces'],
        summary: 'Create a Knowledge Bank entry for a target',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        requestBody: createKnowledgeEntryRequestBody,
        responses: {
          '201': { description: 'Created Knowledge Bank entry.' },
          '403': { description: 'Missing manage_knowledge_bank permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank/entries/{entryId}': {
      patch: {
        tags: ['workspaces'],
        summary: 'Update a Knowledge Bank entry',
        security: [{ userSession: [] }],
        parameters: entryParameters,
        requestBody: updateKnowledgeEntryRequestBody,
        responses: {
          '200': { description: 'Updated Knowledge Bank entry.' },
          '403': { description: 'Missing manage_knowledge_bank permission.' },
          '404': { description: 'Knowledge Bank entry not found.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank/entries/{entryId}/promote': {
      post: {
        tags: ['workspaces'],
        summary: 'Promote a Knowledge Bank entry to active',
        security: [{ userSession: [] }],
        parameters: entryParameters,
        responses: {
          '200': { description: 'Promoted Knowledge Bank entry.' },
          '403': { description: 'Missing manage_knowledge_bank permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank/entries/{entryId}/archive': {
      post: {
        tags: ['workspaces'],
        summary: 'Archive a Knowledge Bank entry',
        security: [{ userSession: [] }],
        parameters: entryParameters,
        responses: {
          '200': { description: 'Archived Knowledge Bank entry.' },
          '403': { description: 'Missing manage_knowledge_bank permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank/reset': {
      post: {
        tags: ['workspaces'],
        summary: 'Hard reset a target Knowledge Bank',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        responses: {
          '200': { description: 'Deleted Knowledge Bank entries and checkpoint state for the target.' },
          '403': { description: 'Missing manage_knowledge_bank permission.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank/activity': {
      get: {
        tags: ['workspaces'],
        summary: 'List Knowledge Bank audit activity for a target',
        security: [{ userSession: [] }],
        parameters: targetParameters,
        responses: {
          '200': { description: 'Knowledge Bank audit activity for the target.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/knowledge-bank/export': {
      get: {
        tags: ['workspaces'],
        summary: 'Export target Knowledge Bank as Markdown',
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
