import { z } from 'zod';

export const agentTransportConfigFields = {
  AGENT_WS_MAX_PAYLOAD_BYTES: z.coerce.number().int()
    .min(2 * 1024 * 1024 + 64 * 1024).max(5 * 1024 * 1024).default(3 * 1024 * 1024),
  AGENT_WS_PREAUTH_MAX_BYTES: z.coerce.number().int().positive().default(16 * 1024),
  AGENT_WS_MAX_DECODED_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  AGENT_WS_HANDSHAKE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  AGENT_WS_PREAUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_WS_PREAUTH_MAX_HANDSHAKES_PER_WINDOW: z.coerce.number().int().positive().default(20),
};

export function validateAgentTransportConfig(
  ctx: z.RefinementCtx,
  value: { AGENT_WS_MAX_PAYLOAD_BYTES: number; AGENT_WS_MAX_DECODED_BYTES: number }
): void {
  if (value.AGENT_WS_MAX_DECODED_BYTES < value.AGENT_WS_MAX_PAYLOAD_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENT_WS_MAX_DECODED_BYTES'],
      message: 'AGENT_WS_MAX_DECODED_BYTES must be greater than or equal to AGENT_WS_MAX_PAYLOAD_BYTES'
    });
  }
}
