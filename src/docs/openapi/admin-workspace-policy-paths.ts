export function buildAdminWorkspacePolicyPaths(): Record<string, unknown> {
  const security = [{ adminBearer: [] }];
  const parameters = [{ in: 'path', name: 'workspaceId', required: true, schema: { type: 'string' } }];
  const common = {
    reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Private administrator reason; never copied into tenant audit metadata.' },
    ticketRef: { type: 'string', maxLength: 128 },
    requestId: { type: 'string', minLength: 1, maxLength: 128, description: 'Credential/workspace/operation-scoped idempotency key, retained for 30 days. Expired requests must pass the version check. Required for narrow machine mutations.' },
    expectedPolicyVersion: { type: 'integer', minimum: 0, description: 'Required whenever requestId is supplied and for all narrow machine mutations; checked even for a no-op.' },
    overLimitBehavior: { type: 'string', enum: ['reject', 'retain_existing'], default: 'reject' },
    source: { type: 'string', enum: ['admin', 'external'], default: 'admin', description: 'External hold credentials must explicitly select external.' },
    publicReason: { type: 'string', minLength: 1, maxLength: 500 }
  };
  const mutation = (summary: string, required: string[], properties: Record<string, unknown>) => ({
    tags: ['admin'], summary, security,
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason', ...required], properties: { ...common, ...properties }, allOf: [{ anyOf: [{ not: { required: ['requestId'] } }, { required: ['expectedPolicyVersion'] }] }], additionalProperties: false } } } },
    responses: {
      '200': { description: 'Committed before/after workspace data, bounded policy snapshot and changed flag. Plan changes also retain usage and overLimit. Identical request replay returns the original response.' },
      '400': { description: 'VALIDATION_ERROR, POLICY_PRECONDITION_REQUIRED or WORKSPACE_PLAN_NOT_CONFIGURED.' },
      '403': { description: 'Scope, hold source, human role, recent authentication or CSRF requirement not met.' },
      '404': { description: 'Workspace not found.' },
      '409': { description: 'WORKSPACE_POLICY_VERSION_CONFLICT, IDEMPOTENCY_CONFLICT or legacy duplicate lifecycle error.' }
    }
  });
  const resourceQuotas = { type: 'object', required: ['members', 'kubernetesClusters', 'virtualMachines'], properties: Object.fromEntries(['members', 'kubernetesClusters', 'virtualMachines'].map(key => [key, { type: 'integer', minimum: 1 }])) };
  const poolNames = ['chat', 'agent', 'workflow', 'autoTriage', 'insights'];
  const executionLimits = { type: 'object', required: poolNames, additionalProperties: false, properties: Object.fromEntries(poolNames.map(pool => [pool, { type: 'object', required: ['maxConcurrentRuns', 'maxOutstandingRuns'], additionalProperties: false, properties: { maxConcurrentRuns: { type: 'integer', nullable: true, minimum: 1 }, maxOutstandingRuns: { type: 'integer', nullable: true, minimum: 1 } } }])) };
  const plan = { type: 'object', required: ['key', 'name', 'quotas', 'executionLimits'], properties: { key: { type: 'string' }, name: { type: 'string' }, quotas: resourceQuotas, executionLimits } };
  const content = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
  const policySchema = { type: 'object', required: ['workspaceId', 'workspaceName', 'plan', 'effectiveLimits', 'quotaOverrides', 'policyVersion', 'usage', 'holds'], properties: {
    workspaceId: { type: 'string' }, workspaceName: { type: 'string' }, plan: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } },
    effectiveLimits: { type: 'object', properties: { plan, quotas: resourceQuotas, executionLimits } },
    quotaOverrides: { type: 'object', properties: Object.fromEntries(['members', 'kubernetesClusters', 'virtualMachines'].map(key => [key, { type: 'integer', minimum: 1, nullable: true }])) },
    publicReason: { type: 'string', nullable: true, description: 'Effective tenant-visible suspension reason; legacy administrator holds use a generic reason.' },
    policyVersion: { type: 'integer', minimum: 0 }, lifecycleStatus: { type: 'string', enum: ['active', 'suspended'] }, suspendedAt: { type: 'string', format: 'date-time', nullable: true },
    usage: { type: 'object', properties: { ...Object.fromEntries(['members', 'kubernetesClusters', 'virtualMachines'].map(key => [key, { type: 'integer', minimum: 0 }])), execution: { type: 'object', properties: Object.fromEntries(poolNames.map(pool => [pool, { type: 'object', properties: { concurrentRuns: { type: 'integer', minimum: 0 }, outstandingRuns: { type: 'integer', minimum: 0 } } }])) } } },
    holds: { type: 'array', maxItems: 2, items: { type: 'object', properties: { source: { type: 'string', enum: ['admin', 'external'] }, publicReason: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } } } }
  } };
  return {
    '/admin/v1/workspace-plans': { get: { tags: ['admin'], summary: 'Read configured workspace plan catalogue', security,
      description: 'Requires admin:workspace:read or admin:workspace:policy:read. Returns defaultPlanKey and plans with quotas and five normalized executionLimits pools.', responses: { '200': { description: 'Configured plan catalogue.', content: content({ type: 'object', required: ['defaultPlanKey', 'plans'], properties: { defaultPlanKey: { type: 'string' }, plans: { type: 'array', items: plan } } }) } } } },
    '/admin/v1/workspaces/{workspaceId}/policy': { parameters, get: { tags: ['admin'], summary: 'Read bounded workspace policy and current usage', security,
      description: 'Requires admin:workspace:read or admin:workspace:policy:read. Returns workspaceId, workspaceName, plan, effectiveLimits, explicit quotaOverrides, policyVersion, lifecycleStatus, suspendedAt, publicReason, usage (members, kubernetesClusters, virtualMachines, execution) and admin/external holds with publicReason and createdAt.', responses: { '200': { description: 'Current workspace policy snapshot.', content: content(policySchema) }, '404': { description: 'Workspace not found.' } } } },
    '/admin/v1/workspaces/{workspaceId}/plan': { parameters, patch: mutation('Change a workspace plan while preserving explicit quota overrides', ['planKey'], { planKey: { type: 'string' } }) },
    '/admin/v1/workspaces/{workspaceId}/quotas': { parameters, patch: mutation('Set or clear resource quota overrides', ['quotas'], { quotas: { type: 'object', nullable: true, additionalProperties: false, properties: Object.fromEntries(['members', 'kubernetesClusters', 'virtualMachines'].map(key => [key, { type: 'integer', minimum: 1 }])) } }) },
    '/admin/v1/workspaces/{workspaceId}/suspend': { parameters, post: mutation('Set the selected suspension hold', ['workspaceName'], { workspaceName: { type: 'string', minLength: 1, maxLength: 200, description: 'Exact current name, including whitespace.' } }) },
    '/admin/v1/workspaces/{workspaceId}/restore': { parameters, post: mutation('Clear the selected hold; access remains suspended while another hold exists', [], { workspaceName: { type: 'string', minLength: 1, maxLength: 200, description: 'Must exactly match when supplied. Optional for legacy restore clients.' } }) }
  };
}
