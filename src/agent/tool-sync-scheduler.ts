import { logger } from '../logger.js';
import { TargetType } from '../types/domain.js';
import { BuiltInToolSyncScheduler } from './types.js';

const defaultBuiltInToolSyncScheduler: BuiltInToolSyncScheduler = (workspaceId, targetId, targetType) => {
  void import('../services/target-built-in-tool-sync.js')
    .then((module) => module.syncTargetBuiltInTools(workspaceId, targetId, targetType))
    .catch((err) => {
      logger.warn({ targetId, targetType, err }, 'Failed scheduling built-in tool sync after agent handshake');
    });
};

let builtInToolSyncScheduler = defaultBuiltInToolSyncScheduler;

export function scheduleBuiltInToolSync(workspaceId: string, targetId: string, targetType: TargetType): void {
  builtInToolSyncScheduler(workspaceId, targetId, targetType);
}

export function setBuiltInToolSyncSchedulerForTests(scheduler?: BuiltInToolSyncScheduler): void {
  builtInToolSyncScheduler = scheduler || defaultBuiltInToolSyncScheduler;
}
