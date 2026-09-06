import { z } from 'zod';

export const capacityConfigFields = {
  WORKSPACE_ADMISSION_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  WORKSPACE_DISPATCH_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  EXECUTION_ENGINE_BASE_URL: z.string().url().default('http://localhost:8080'),
  EXECUTION_ENGINE_DISPATCH_TOKEN: z.string().default('dev_execution_engine_dispatch_token'),
  EXECUTION_ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  WORKSPACE_CAPACITY_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  WORKSPACE_CAPACITY_LEASE_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  WORKSPACE_CAPACITY_QUEUE_SECONDS: z.coerce.number().int().positive().default(600)
};
