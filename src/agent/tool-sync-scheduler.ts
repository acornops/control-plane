import { logger } from '../logger.js';
import { TargetType } from '../types/domain.js';
import { BuiltInToolSyncRunner, BuiltInToolSyncScheduler } from './types.js';

const DEFAULT_RETRY_DELAYS_MS = [0, 2_000, 10_000, 30_000];

interface ScheduledSync {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  attempt: number;
  timer?: NodeJS.Timeout;
}

const scheduledSyncs = new Map<string, ScheduledSync>();

const defaultBuiltInToolSyncRunner: BuiltInToolSyncRunner = async (workspaceId, targetId, targetType) => {
  const module = await import('../services/target-built-in-tool-sync.js');
  return module.syncTargetBuiltInTools(workspaceId, targetId, targetType);
};

let builtInToolSyncRunner = defaultBuiltInToolSyncRunner;
let builtInToolSyncRetryDelaysMs = DEFAULT_RETRY_DELAYS_MS;

function syncKey(workspaceId: string, targetId: string, targetType: TargetType): string {
  return `${workspaceId}:${targetType}:${targetId}`;
}

function shouldRetry(result: Awaited<ReturnType<BuiltInToolSyncRunner>>): boolean {
  return !result.ok || result.discoveredToolCount === 0 || result.registeredToolCount === 0;
}

function retryReason(result: Awaited<ReturnType<BuiltInToolSyncRunner>>): string {
  if (!result.ok) return 'sync_failed';
  if (result.discoveredToolCount === 0) return 'no_agent_tools_discovered';
  if (result.registeredToolCount === 0) return 'no_gateway_tools_registered';
  return 'not_retryable';
}

function queueSync(state: ScheduledSync): void {
  const delayMs = builtInToolSyncRetryDelaysMs[Math.min(state.attempt, builtInToolSyncRetryDelaysMs.length - 1)] ?? 0;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void runSyncAttempt(state);
  }, delayMs);
  state.timer.unref();
}

async function runSyncAttempt(state: ScheduledSync): Promise<void> {
  const key = syncKey(state.workspaceId, state.targetId, state.targetType);
  let result: Awaited<ReturnType<BuiltInToolSyncRunner>>;
  try {
    result = await builtInToolSyncRunner(state.workspaceId, state.targetId, state.targetType);
  } catch (err) {
    result = {
      ok: false,
      workspaceId: state.workspaceId,
      targetId: state.targetId,
      targetType: state.targetType,
      discoveredToolCount: 0,
      registeredToolCount: 0,
      addedTools: [],
      removedTools: [],
      error: err instanceof Error ? err.message : 'Built-in tool sync failed'
    };
  }

  if (!shouldRetry(result)) {
    scheduledSyncs.delete(key);
    logger.info(
      {
        workspaceId: state.workspaceId,
        targetId: state.targetId,
        targetType: state.targetType,
        attempt: state.attempt + 1,
        discoveredToolCount: result.discoveredToolCount,
        registeredToolCount: result.registeredToolCount
      },
      'Built-in tool sync completed after agent handshake'
    );
    return;
  }

  if (state.attempt + 1 >= builtInToolSyncRetryDelaysMs.length) {
    scheduledSyncs.delete(key);
    logger.warn(
      {
        workspaceId: state.workspaceId,
        targetId: state.targetId,
        targetType: state.targetType,
        attempts: state.attempt + 1,
        reason: retryReason(result),
        error: result.error
      },
      'Built-in tool sync remained incomplete after agent handshake retries'
    );
    return;
  }

  logger.warn(
    {
      workspaceId: state.workspaceId,
      targetId: state.targetId,
      targetType: state.targetType,
      attempt: state.attempt + 1,
      nextDelayMs: builtInToolSyncRetryDelaysMs[state.attempt + 1],
      reason: retryReason(result),
      error: result.error
    },
    'Retrying built-in tool sync after agent handshake'
  );
  state.attempt += 1;
  queueSync(state);
}

const defaultBuiltInToolSyncScheduler: BuiltInToolSyncScheduler = (workspaceId, targetId, targetType) => {
  const key = syncKey(workspaceId, targetId, targetType);
  if (scheduledSyncs.has(key)) {
    logger.debug({ workspaceId, targetId, targetType }, 'Built-in tool sync already scheduled after agent handshake');
    return;
  }
  const state: ScheduledSync = {
    workspaceId,
    targetId,
    targetType,
    attempt: 0
  };
  scheduledSyncs.set(key, state);
  queueSync(state);
};

let builtInToolSyncScheduler = defaultBuiltInToolSyncScheduler;

export function scheduleBuiltInToolSync(workspaceId: string, targetId: string, targetType: TargetType): void {
  builtInToolSyncScheduler(workspaceId, targetId, targetType);
}

export function setBuiltInToolSyncSchedulerForTests(scheduler?: BuiltInToolSyncScheduler): void {
  builtInToolSyncScheduler = scheduler || defaultBuiltInToolSyncScheduler;
}

export function setBuiltInToolSyncRunnerForTests(runner?: BuiltInToolSyncRunner): void {
  builtInToolSyncRunner = runner || defaultBuiltInToolSyncRunner;
}

export function setBuiltInToolSyncRetryDelaysForTests(delays?: number[]): void {
  builtInToolSyncRetryDelaysMs = delays && delays.length > 0 ? delays : DEFAULT_RETRY_DELAYS_MS;
}

export function resetBuiltInToolSyncSchedulerStateForTests(): void {
  for (const state of scheduledSyncs.values()) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
  scheduledSyncs.clear();
  builtInToolSyncScheduler = defaultBuiltInToolSyncScheduler;
  builtInToolSyncRunner = defaultBuiltInToolSyncRunner;
  builtInToolSyncRetryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
}
