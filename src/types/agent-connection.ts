export interface TargetConnectionObservation {
  state: 'connected' | 'disconnected' | 'unknown';
  lastHeartbeatAt: string | null;
  observedAt: string;
  expiresAt: string | null;
  hasConnectionEvidence: boolean;
}

export const targetConnectionObservationSchema = {
  type: 'object',
  required: ['state', 'lastHeartbeatAt', 'observedAt', 'expiresAt', 'hasConnectionEvidence'],
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: ['connected', 'disconnected', 'unknown'] },
    lastHeartbeatAt: { type: ['string', 'null'], format: 'date-time' },
    observedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    hasConnectionEvidence: { type: 'boolean', description: 'A connection identity or heartbeat was recorded, even if its timestamp is unusable. False distinguishes missing evidence for initial setup.' }
  }
};
