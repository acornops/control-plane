import { logger } from '../logger.js';
import { config } from '../config.js';
import { repo } from '../store/repository.js';

const PURGE_BATCH_SIZE = 500;

type RetentionTaskName =
  | 'conversations'
  | 'webhook_history'
  | 'workspace_audit_events'
  | 'external_integration_link_tokens'
  | 'target_metric_history';

interface RetentionSweepTasks {
  conversations: () => Promise<number>;
  webhookHistory: () => Promise<number>;
  workspaceAuditEvents: () => Promise<number>;
  externalIntegrationLinkTokens: () => Promise<number>;
  targetMetricHistory: () => Promise<number>;
}

/**
 * Purges expired and soft-deleted sessions in bounded batches.
 *
 * Cascading foreign keys remove associated messages/runs/run_events.
 */
export async function purgeExpiredConversations(): Promise<number> {
  let purgedTotal = 0;
  while (true) {
    const purged = await repo.purgeExpiredOrDeletedSessions(PURGE_BATCH_SIZE);
    purgedTotal += purged;
    if (purged < PURGE_BATCH_SIZE) {
      break;
    }
  }

  if (purgedTotal > 0) {
    logger.info({ purgedTotal }, 'Purged expired/deleted conversations');
  }

  return purgedTotal;
}

async function runRetentionTask(name: RetentionTaskName, task: () => Promise<number>): Promise<void> {
  try {
    await task();
  } catch (err) {
    logger.warn({ err, task: name }, 'Retention task failed');
  }
}

export async function runControlPlaneRetentionSweep(tasks: RetentionSweepTasks = {
  conversations: purgeExpiredConversations,
  webhookHistory: purgeOldWebhookHistory,
  workspaceAuditEvents: purgeOldWorkspaceAuditEvents,
  externalIntegrationLinkTokens: purgeOldExternalIntegrationLinkTokens,
  targetMetricHistory: purgeOldTargetMetricHistory
}): Promise<void> {
  await runRetentionTask('conversations', tasks.conversations);
  await runRetentionTask('webhook_history', tasks.webhookHistory);
  await runRetentionTask('workspace_audit_events', tasks.workspaceAuditEvents);
  await runRetentionTask('external_integration_link_tokens', tasks.externalIntegrationLinkTokens);
  await runRetentionTask('target_metric_history', tasks.targetMetricHistory);
}

export async function purgeOldWebhookHistory(): Promise<number> {
  let purgedTotal = 0;
  while (true) {
    const purged = await repo.purgeOldWebhookHistory(config.WEBHOOK_HISTORY_RETENTION_DAYS, PURGE_BATCH_SIZE);
    purgedTotal += purged;
    if (purged < PURGE_BATCH_SIZE) {
      break;
    }
  }

  if (purgedTotal > 0) {
    logger.info({ purgedTotal }, 'Purged old webhook history');
  }

  return purgedTotal;
}

export async function purgeOldWorkspaceAuditEvents(): Promise<number> {
  let purgedTotal = 0;
  while (true) {
    const purged = await repo.purgeOldWorkspaceAuditEvents(config.WORKSPACE_AUDIT_RETENTION_DAYS, PURGE_BATCH_SIZE);
    purgedTotal += purged;
    if (purged < PURGE_BATCH_SIZE) {
      break;
    }
  }

  if (purgedTotal > 0) {
    logger.info({ purgedTotal }, 'Purged old workspace audit events');
  }

  return purgedTotal;
}

export async function purgeOldExternalIntegrationLinkTokens(): Promise<number> {
  let purgedTotal = 0;
  while (true) {
    const purged = await repo.purgeOldExternalIntegrationLinkTokens(config.EXTERNAL_INTEGRATION_LINK_TOKEN_RETENTION_DAYS, PURGE_BATCH_SIZE);
    purgedTotal += purged;
    if (purged < PURGE_BATCH_SIZE) {
      break;
    }
  }

  if (purgedTotal > 0) {
    logger.info({ purgedTotal }, 'Purged old external integration link tokens');
  }

  return purgedTotal;
}

export async function purgeOldTargetMetricHistory(): Promise<number> {
  let purgedTotal = 0;
  while (true) {
    const purged = await repo.purgeOldTargetMetricHistory(config.TARGET_METRIC_HISTORY_RETENTION_DAYS, PURGE_BATCH_SIZE);
    purgedTotal += purged;
    if (purged < PURGE_BATCH_SIZE) {
      break;
    }
  }

  if (purgedTotal > 0) {
    logger.info({ purgedTotal }, 'Purged old target metric history');
  }

  return purgedTotal;
}
