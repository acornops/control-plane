import { config } from '../../config.js';

export function distributedRoutingEnabled(): boolean {
  return config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED;
}

export function controlPlaneInstanceId(): string {
  return config.CONTROL_PLANE_INSTANCE_ID;
}

export function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
