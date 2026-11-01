import type { TargetConnectionObservation } from '../types/agent-connection.js';

export function reportedConnectionStatus(target: {
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  connection?: TargetConnectionObservation;
}): typeof target.status {
  if (target.connection?.state === 'disconnected') return 'offline';
  if (target.connection?.state === 'unknown') return 'unknown';
  return target.status;
}

/** Reporting only: routing continues to use the live socket and owner lease. */
export function observeAgentConnection(
  status: 'online' | 'offline' | 'degraded' | 'unknown',
  connectionId: string | null | undefined,
  heartbeatAt: Date | string | null | undefined,
  observedAt: Date | string,
  graceSeconds: number
): TargetConnectionObservation {
  const observed = new Date(observedAt);
  const heartbeat = heartbeatAt == null ? NaN : new Date(heartbeatAt).getTime();
  const valid = Number.isFinite(heartbeat) && heartbeat <= observed.getTime();
  const expires = valid ? heartbeat + graceSeconds * 1000 : null;
  return {
    state: status === 'offline' ? 'disconnected'
      : status === 'unknown' || !connectionId || !valid ? 'unknown'
        : observed.getTime() < expires! ? 'connected' : 'disconnected',
    lastHeartbeatAt: valid ? new Date(heartbeat).toISOString() : null,
    observedAt: observed.toISOString(),
    expiresAt: expires === null ? null : new Date(expires).toISOString(),
    hasConnectionEvidence: Boolean(connectionId) || heartbeatAt != null
  };
}
