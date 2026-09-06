import { z } from 'zod';

export const EXECUTION_POOLS = ['chat', 'agent', 'workflow', 'autoTriage', 'insights'] as const;
export type ExecutionPool = typeof EXECUTION_POOLS[number];
const limit = z.number().int().positive().finite().nullable();
const executionPoolLimitsSchema = z.object({ maxConcurrentRuns: limit, maxOutstandingRuns: limit }).strict().refine(
  value => value.maxConcurrentRuns === null ? value.maxOutstandingRuns === null : value.maxOutstandingRuns !== null && value.maxOutstandingRuns >= value.maxConcurrentRuns,
  'Execution limits must be a null pair or positive integers with outstanding >= concurrent'
);
export type ExecutionPoolLimits = z.infer<typeof executionPoolLimitsSchema>;
export type ExecutionLimits = Record<ExecutionPool, ExecutionPoolLimits>;
export type ExecutionUsage = Record<ExecutionPool, { concurrentRuns: number; outstandingRuns: number }>;
const executionLimitsSchema = z.object({
  chat: executionPoolLimitsSchema.optional(), agent: executionPoolLimitsSchema.optional(), workflow: executionPoolLimitsSchema.optional(),
  autoTriage: executionPoolLimitsSchema.optional(), insights: executionPoolLimitsSchema.optional()
}).strict();
export function resolveExecutionLimits(input?: unknown): ExecutionLimits {
  const parsed = executionLimitsSchema.parse(input === undefined ? {} : input);
  return Object.fromEntries(EXECUTION_POOLS.map(pool => [pool, parsed[pool] ?? { maxConcurrentRuns: null, maxOutstandingRuns: null }])) as ExecutionLimits;
}
export const DEFAULT_ADMIN_SUSPENSION_REASON = 'Workspace access is temporarily suspended by an administrator.';
export class WorkspacePolicyError extends Error {
  auditRecorded = false;
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
