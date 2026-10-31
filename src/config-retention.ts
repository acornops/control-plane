import { z } from 'zod';

export const retentionConfigFields = {
  CONVERSATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  CONVERSATION_RETENTION_JOB_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  SKILL_SNAPSHOT_BLOB_ORPHAN_GRACE_DAYS: z.coerce.number().int().positive().default(7),
  TARGET_METRIC_HISTORY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  TARGET_ISSUE_OBSERVATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30)
};
