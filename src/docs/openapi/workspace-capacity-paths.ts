const runParameter = { in: 'path', name: 'runId', required: true, schema: { type: 'string' } };
const owner = { type: 'string', minLength: 1, maxLength: 200 };
const generation = { type: 'integer', minimum: 1 };
const operationId = { type: 'string', minLength: 1, maxLength: 200 };
export const executionAuthorityHeaders = [
  { in: 'header', name: 'x-acornops-execution-owner', required: false, schema: owner, description: 'Required for run callbacks and gateway requests while capacity is enabled.' },
  { in: 'header', name: 'x-acornops-execution-generation', required: false, schema: { type: 'string' }, description: 'Current grant generation. Cleanup retains the originating generation after authority loss.' }
];
export const workspaceAccessStateSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'name', 'accessState'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, accessState: { type: 'string', enum: ['active', 'suspended'] },
    publicReason: { type: 'string' }, suspendedAt: { type: 'string', format: 'date-time' } }
};
export function buildWorkspaceCapacityPaths(): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    '/api/v1/workspaces/{workspaceId}/access-state': { get: {
      tags: ['workspaces'], summary: 'Read minimal workspace access state for a current member', security: [{ userSession: [] }],
      description: 'Includes suspended memberships without granting workload access. Public reason excludes private administrative reasons. Returns Cache-Control: no-store.',
      parameters: [{ in: 'path', name: 'workspaceId', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Safe workspace identity and access state', content: { 'application/json': { schema: workspaceAccessStateSchema } } },
        '401': { description: 'User session required' }, '404': { description: 'Missing workspace or not a member' } }
    } }
  };
  const actions: Array<[string, Record<string, unknown>, string[]]> = [
    ['authorize', { workspaceId: { type: 'string' } }, ['workspaceId']],
    ['acquire', { ownerId: owner }, ['ownerId']],
    ['renew', { ownerId: owner, generation }, ['ownerId', 'generation']],
    ['release', { ownerId: owner, generation, state: { type: 'string', enum: ['parked', 'settling'], default: 'settling' } }, ['ownerId', 'generation']],
    ['operations/begin', { ownerId: owner, generation, operationId, timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000 } }, ['ownerId', 'generation', 'operationId', 'timeoutMs']],
    ['operations/finish', { ownerId: owner, generation, operationId }, ['ownerId', 'generation', 'operationId']]
  ];
  for (const [action, properties, required] of actions) paths[`/internal/v1/runs/{runId}/capacity/${action}`] = { post: {
    tags: ['internal'], summary: `Internal: execution capacity ${action}`, security: [{ serviceToken: [] }], parameters: [runParameter],
    description: 'Server-owned attempt identity, independent execution pools, and generation fencing. Authorization checks lifecycle even with limits disabled. Release/finish permit bounded cleanup. Expired ownership cannot authorize new operations.',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties, required } } } },
    responses: { '200': { description: 'contractVersion:1; authorize returns status:ok and capacityEnabled. Acquire returns granted (generation,pool,leaseSeconds), wait (pool), blocked, or disabled. Other operations return ok or disabled.' },
      '403': { description: 'Workspace suspended or identity denied' }, '404': { description: 'Attempt missing' },
      '409': { description: 'Authority lost, operation replay, or operation still active' }, '503': { description: 'Capacity authority unavailable; fail closed' } }
  } };
  paths['/internal/v1/runs/{runId}/dependency-wait'] = { post: {
    tags: ['internal'], summary: 'Internal: persist a coordinator dependency continuation', security: [{ serviceToken: [] }],
    parameters: [runParameter, ...executionAuthorityHeaders],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
      required: ['generation', 'state'], properties: { generation: { type: 'integer', minimum: 0 }, state: { type: 'object', additionalProperties: true } } } } } },
    responses: { '204': { description: 'Durable continuation saved. Release the grant as parked after unwinding. The existing continuation GET returns kind:dependency and state; DELETE consumes it.' }, '409': { description: 'Coordinator or generation unavailable' } }
  } };
  return paths;
}
