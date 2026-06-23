import {
  EXAMPLE_CLUSTER_ID,
  EXAMPLE_RUN_ID,
  EXAMPLE_SESSION_ID,
  EXAMPLE_TARGET_ID,
  EXAMPLE_TRACE_ID,
  EXAMPLE_USER_ID,
  EXAMPLE_WORKSPACE_ID
} from '../../constants/dev-defaults.js';

const externalUserHeader = {
  in: 'header',
  name: 'x-acornops-external-user-id',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 128 },
  description: 'Required only for external integration service-token requests. Must identify a linked external integration user.'
};

export function buildSessionRunPaths(): Record<string, unknown> {
  return {
      '/api/v1/workspaces/{workspaceId}/targets/{targetId}/sessions': {
        get: {
          tags: ['sessions'],
          summary: 'List troubleshooting sessions for target',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, example: 20 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string', example: 'eyJsYXN0TWVzc2FnZUF0IjoiMjAyNi0wMy0wM1QxMjowMDowMC4wMDBaIiwic2Vzc2lvbklkIjoi...' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'status', required: false, schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Session page payload.' } }
        },
        post: {
          tags: ['sessions'],
          summary: 'Create troubleshooting session for target',
          description: 'External integration callers may create sessions only when the linked user role and bot allowlist grant create_sessions.',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: { title: { type: 'string', example: 'Investigate CrashLoopBackOff in payments-api' } },
                  example: { title: 'Investigate CrashLoopBackOff in payments-api' }
                }
              }
            }
          },
          responses: { '201': { description: 'Session created.' } }
        }
      },
      '/api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity': {
        get: {
          tags: ['sessions'],
          summary: 'List recent target chat activity',
          description: 'Returns recent non-deleted, non-expired troubleshooting sessions with message/run activity for the target. Requires target read access, not chat creation permission.',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
            { in: 'query', name: 'windowSeconds', required: false, schema: { type: 'integer', minimum: 60, maximum: 3600, default: 300 } }
          ],
          responses: {
            '200': {
              description: 'Recent activity payload with target metadata, windowSeconds, generatedAt, and recentActivity rows including owner display metadata, last run, active run, and write-capable activity flags.'
            }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity/stream': {
        get: {
          tags: ['sessions'],
          summary: 'Stream target chat activity',
          description: 'Long-lived SSE stream for browser-facing target chat activity. Frames use event: chat_activity, id: activity event id, and JSON data with resource identifiers. Supports Last-Event-ID and the optional after query parameter for resume replay; connections without a resume cursor are live-only.',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
            { in: 'query', name: 'after', required: false, schema: { type: 'string', example: '42' } },
            { in: 'header', name: 'Last-Event-ID', required: false, schema: { type: 'string', example: '42' } }
          ],
          responses: {
            '200': {
              description: 'SSE stream of target chat activity events.'
            }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/kubernetes-clusters/{clusterId}/sessions': {
        get: {
          tags: ['sessions'],
          summary: 'List troubleshooting sessions for cluster',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, example: 20 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string', example: 'eyJsYXN0TWVzc2FnZUF0IjoiMjAyNi0wMy0wM1QxMjowMDowMC4wMDBaIiwic2Vzc2lvbklkIjoi...' } },
            { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
            { in: 'query', name: 'status', required: false, schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Session page payload.' } }
        },
        post: {
          tags: ['sessions'],
          summary: 'Create troubleshooting session for cluster',
          description: 'External integration callers may create sessions only when the linked user role and bot allowlist grant create_sessions.',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'clusterId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_CLUSTER_ID } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: { title: { type: 'string', example: 'Investigate CrashLoopBackOff in payments-api' } },
                  example: { title: 'Investigate CrashLoopBackOff in payments-api' }
                }
              }
            }
          },
          responses: { '201': { description: 'Session created.' } }
        }
      },
      '/api/v1/sessions/{sessionId}': {
        get: {
          tags: ['sessions'],
          summary: 'Get session metadata',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'sessionId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_SESSION_ID } }
          ],
          responses: { '200': { description: 'Session details.' } }
        },
        delete: {
          tags: ['sessions'],
          summary: 'Delete a troubleshooting session',
          security: [{ userSession: [] }],
          parameters: [{ in: 'path', name: 'sessionId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_SESSION_ID } }],
          responses: { '204': { description: 'Session deleted.' } }
        }
      },
      '/api/v1/sessions/{sessionId}/messages': {
        get: {
          tags: ['sessions'],
          summary: 'List session messages',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'sessionId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_SESSION_ID } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
            { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }
          ],
          responses: { '200': { description: 'Message page payload: { items, nextCursor? }.' } }
        },
        post: {
          tags: ['sessions'],
          summary: 'Append user message and trigger run dispatch',
          description: 'External integration callers may append messages only to sessions owned by the linked AcornOps user and may trigger read-only troubleshooting runs only.',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'sessionId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_SESSION_ID } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['content'],
                  properties: {
                    content: { type: 'string', example: 'Pods restarted after rollout, but p95 latency is still elevated. Check likely causes.' },
                    toolAccessMode: { type: 'string', enum: ['read_only', 'read_write'], example: 'read_only' },
                    clientMessageId: { type: 'string', example: '4f004ae2-4288-4baf-9be4-124d61180f0c-msg-1' }
                  },
                  example: {
                    content: 'Pods restarted after rollout, but p95 latency is still elevated. Check likely causes.',
                    toolAccessMode: 'read_only',
                    clientMessageId: '4f004ae2-4288-4baf-9be4-124d61180f0c-msg-1'
                  }
                }
              }
            }
          },
          responses: {
            '202': { description: 'Run accepted for processing.' },
            '400': { description: 'Unsupported target type for troubleshooting runs in this release.' },
            '403': { description: 'CONVERSATION_OWNER_REQUIRED when the authenticated user did not create the conversation, or FORBIDDEN when the owner lacks run creation permission.' }
          }
        }
      },
      '/api/v1/runs/{runId}': {
        get: {
          tags: ['runs'],
          summary: 'Get run state',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }
          ],
          responses: { '200': { description: 'Run details.' } }
        }
      },
      '/api/v1/runs/{runId}/approvals': {
        get: {
          tags: ['runs'],
          summary: 'List write-tool approvals for a run',
          description: 'Returns pending and decided write-tool approvals for visibility. External integration callers may read approval state but cannot decide approvals.',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }
          ],
          responses: { '200': { description: 'Run tool approval list.' } }
        }
      },
      '/internal/v1/runs/{runId}/approvals': {
        post: {
          tags: ['internal'],
          summary: 'Internal: create durable write-tool approval interrupt',
          description: 'Atomically creates the approval row, stores the run continuation, and moves the run to waiting_for_approval.',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['toolCallId', 'toolName', 'arguments'],
                  properties: {
                    toolCallId: { type: 'string', example: 'call_01JABCDEF' },
                    toolName: { type: 'string', example: 'restart_workload' },
                    summary: {
                      type: 'string',
                      example: 'Restart Deployment payments/payments-api.',
                      description: 'Human-readable, non-authoritative description for approval UI.'
                    },
                    arguments: { type: 'object', additionalProperties: true },
                    continuation: {
                      type: 'object',
                      additionalProperties: true,
                      description: 'Serialized resumable ReAct state. Gateway tokens and other credentials must not be stored here.'
                    }
                  },
                  example: {
                    toolCallId: 'call_01JABCDEF',
                    toolName: 'restart_workload',
                    summary: 'Restart Deployment payments/payments-api.',
                    arguments: { namespace: 'payments', name: 'payments-api', kind: 'Deployment' },
                    continuation: { schema_version: 1, pending_tool_call: { tool: 'restart_workload' } }
                  }
                }
              }
            }
          },
          responses: { '201': { description: 'Approval interrupt persisted.' } }
        }
      },
      '/api/v1/runs/{runId}/approvals/{approvalId}/decision': {
        post: {
          tags: ['runs'],
          summary: 'Approve or reject a pending write-tool approval',
          description: 'Requires a real AcornOps user with create_read_write_runs for approval. Bots may relay this decision only when they can authenticate and attribute that user.',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } },
            { in: 'path', name: 'approvalId', required: true, schema: { type: 'string', format: 'uuid', example: '0f2e8f75-0d66-4f40-b3d0-f4c4661c43a1' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['decision'],
                  properties: { decision: { type: 'string', enum: ['approved', 'rejected'] } },
                  example: { decision: 'approved' }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Decision recorded. Repeated identical decisions are idempotent.' },
            '403': { description: 'The authenticated user cannot approve write runs.' },
            '409': { description: 'The approval was already decided, expired before the decision was recorded, or received a conflicting decision.' }
          }
        }
      },
      '/internal/v1/runs/{runId}/continuation': {
        get: {
          tags: ['internal'],
          summary: 'Internal: fetch durable run continuation for approval resume',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          responses: { '200': { description: 'Stored continuation and current approval, or null when none exists.' } }
        },
        delete: {
          tags: ['internal'],
          summary: 'Internal: consume durable run continuation',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          responses: { '204': { description: 'Continuation deleted.' } }
        }
      },
      '/internal/v1/runs/{runId}/approvals/{approvalId}/execution-started': {
        post: {
          tags: ['internal'],
          summary: 'Internal: claim approved write execution',
          description: 'Marks an approved write as executing. If a previous execution attempt was already in progress, the approval is marked unknown and the engine must fail closed without retrying the write.',
          security: [{ serviceToken: [] }],
          parameters: [
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } },
            { in: 'path', name: 'approvalId', required: true, schema: { type: 'string', format: 'uuid', example: '0f2e8f75-0d66-4f40-b3d0-f4c4661c43a1' } }
          ],
          responses: { '200': { description: 'Approval execution status returned.' } }
        }
      },
      '/internal/v1/runs/{runId}/approvals/{approvalId}/execution-finished': {
        post: {
          tags: ['internal'],
          summary: 'Internal: persist approved write execution result',
          security: [{ serviceToken: [] }],
          parameters: [
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } },
            { in: 'path', name: 'approvalId', required: true, schema: { type: 'string', format: 'uuid', example: '0f2e8f75-0d66-4f40-b3d0-f4c4661c43a1' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['result'],
                  properties: {
                    result: {},
                    isError: { type: 'boolean', default: false }
                  },
                  example: { result: { status: 'ok' }, isError: false }
                }
              }
            }
          },
          responses: { '200': { description: 'Approval execution result persisted.' } }
        }
      },
      '/api/v1/runs/{runId}/cancel': {
        post: {
          tags: ['runs'],
          summary: 'Cancel an in-flight run',
          security: [{ userSession: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          responses: { '202': { description: 'Cancellation accepted.' } }
        }
      },
      '/api/v1/runs/{runId}/stream': {
        get: {
          tags: ['runs'],
          summary: 'Server-Sent Events stream for run events',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }
          ],
          responses: { '200': { description: 'SSE event stream.' } }
        }
      },
      '/internal/v1/runs/{runId}/bootstrap': {
        post: {
          tags: ['internal'],
          summary: 'Internal: bootstrap execution snapshot for run',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          responses: { '200': { description: 'Execution snapshot returned.' } }
        }
      },
      '/internal/v1/sessions/{sessionId}/context': {
        get: {
          tags: ['internal'],
          summary: 'Internal: resolve session context for run',
          security: [{ serviceToken: [] }],
          parameters: [
            { in: 'path', name: 'sessionId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_SESSION_ID } },
            { in: 'query', name: 'run_id', required: false, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }
          ],
          responses: { '200': { description: 'Context package returned.' } }
        }
      },
      '/internal/v1/runs/{runId}/events': {
        post: {
          tags: ['internal'],
          summary: 'Internal: ingest run events batch',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['events'],
                  properties: { events: { type: 'array', items: { type: 'object' } } },
                  example: {
                    events: [
                      {
                        schema_version: 1,
                        run_id: EXAMPLE_RUN_ID,
                        seq: 1,
                        ts: '2026-03-01T00:00:00.000Z',
                        type: 'run_started',
                        payload: {
                          user_id: EXAMPLE_USER_ID,
                          trace_id: EXAMPLE_TRACE_ID
                        }
                      }
                    ]
                  }
                }
              }
            }
          },
          responses: { '200': { description: 'Events accepted.' } }
        }
      },
      '/api/v1/runs/{runId}/events': {
        get: {
          tags: ['runs'],
          summary: 'List run events replay',
          security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
          parameters: [
            externalUserHeader,
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }
          ],
          responses: { '200': { description: 'Run events list.' } }
        }
      },
      '/internal/v1/runs/{runId}/event-cursor': {
        get: {
          tags: ['internal'],
          summary: 'Internal: get latest replayable run event sequence',
          description: 'Execution-engine uses this cursor before emitting resumed approval events so replay sequence numbers remain monotonic.',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          responses: {
            '200': {
              description: 'Latest replayable event sequence.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['latestSeq'],
                    properties: { latestSeq: { type: 'integer', minimum: 0, example: 16 } }
                  }
                }
              }
            },
            '404': { description: 'Run not found.' }
          }
        }
      },
      '/internal/v1/runs/{runId}/commit': {
        post: {
          tags: ['internal'],
          summary: 'Internal: commit run completion payload',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'usage', 'timing'],
                  properties: {
                    status: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
                    assistant_message: { type: 'object', nullable: true },
                    usage: { type: 'object' },
                    timing: { type: 'object' }
                  },
                  example: {
                    status: 'completed',
                    assistant_message: {
                      content:
                        'Primary issue is a failing readiness probe. Increase timeout to 10s and verify upstream DNS latency.',
                      format: 'markdown'
                    },
                    usage: {
                      input_tokens: 642,
                      output_tokens: 311,
                      tool_calls: 2,
                      reasoning_tokens: 42
                    },
                    timing: {
                      started_at: '2026-03-01T00:00:00.000Z',
                      ended_at: '2026-03-01T00:00:06.500Z'
                    }
                  }
                }
              }
            }
          },
          responses: { '200': { description: 'Run committed.' } }
        },
        get: {
          tags: ['internal'],
          summary: 'Internal: get final run commit payload',
          security: [{ serviceToken: [] }],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID } }],
          responses: { '200': { description: 'Committed run payload or empty object.' } }
        }
      },
  };
}
