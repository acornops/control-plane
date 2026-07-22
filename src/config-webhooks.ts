import { z } from 'zod';

type BooleanSchemaFactory = (defaultValue: boolean) => z.ZodTypeAny;

export function webhookConfigShape(envBoolean: BooleanSchemaFactory) {
  return {
    WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    WEBHOOK_EGRESS_ALLOWED_PRIVATE_HOSTS_JSON: z.string().default('[]'),
    WEBHOOK_HISTORY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    WEBHOOK_WORKER_ENABLED: envBoolean(true),
    WEBHOOK_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(50),
    WEBHOOK_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(20),
    WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
    WEBHOOK_MAX_RETRY_AGE_SECONDS: z.coerce.number().int().min(60).max(604800).default(86400),
    WEBHOOK_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).max(1048576).default(65536),
    WEBHOOK_MAX_SUBSCRIPTIONS_PER_WORKSPACE: z.coerce.number().int().min(1).max(1000).default(100)
  };
}
