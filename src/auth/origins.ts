import { config } from '../config.js';

export function parseAllowedOrigins(value: string): '*' | string[] {
  if (value.trim() === '*') return '*';
  return Array.from(new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean)));
}

export function corsOriginOption(): true | string[] {
  const origins = parseAllowedOrigins(config.CORS_ORIGIN);
  return origins === '*' ? true : origins;
}

export function allowedReturnToOrigins(): Set<string> {
  const allowedOrigins = new Set<string>();
  const corsOrigins = parseAllowedOrigins(config.CORS_ORIGIN);
  if (corsOrigins !== '*') {
    for (const origin of corsOrigins) {
      allowedOrigins.add(origin);
    }
  }
  allowedOrigins.add(new URL(config.CONTROL_PLANE_BASE_URL).origin);
  allowedOrigins.add(new URL(config.MANAGEMENT_CONSOLE_BASE_URL).origin);
  return allowedOrigins;
}
