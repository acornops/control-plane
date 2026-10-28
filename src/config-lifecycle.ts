import { z } from 'zod';

export const lifecycleConfigFields = {
  SERVICE_DRAIN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(150),
  AGENT_HANDOFF_TIMEOUT_MS: z.coerce.number().int().positive().max(45_000).default(45_000)
};
