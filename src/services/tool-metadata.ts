const TOOL_METADATA_MAX_CHARS = 500;
const TOOL_SCHEMA_MAX_DEPTH = 8;
const TOOL_SCHEMA_MAX_ITEMS = 100;
const TOOL_SCHEMA_TEXT_KEYS = new Set(['description', 'markdownDescription', 'title']);
const TOOL_METADATA_INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|messages|rules)\b/i,
  /\b(?:reveal|print|dump|exfiltrate)\b.*\b(?:system prompt|developer message|secret|api key|token)\b/i,
  /\b(?:bypass|disable)\s+(?:safety|policy|guardrails|rules)\b/i,
  /\bjailbreak\b/i
];

function containsPromptInjectionText(value: string): boolean {
  return TOOL_METADATA_INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeToolText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || containsPromptInjectionText(normalized)) return null;
  return normalized.slice(0, TOOL_METADATA_MAX_CHARS);
}

function sanitizeToolSchemaValue(value: unknown, key?: string, depth = 0): unknown {
  if (depth > TOOL_SCHEMA_MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.slice(0, TOOL_SCHEMA_MAX_ITEMS).map((item) => sanitizeToolSchemaValue(item, undefined, depth + 1));
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, TOOL_SCHEMA_MAX_ITEMS)) {
      const sanitizedValue = sanitizeToolSchemaValue(entryValue, entryKey, depth + 1);
      if (sanitizedValue === null && TOOL_SCHEMA_TEXT_KEYS.has(entryKey)) continue;
      sanitized[entryKey] = sanitizedValue;
    }
    return sanitized;
  }
  if (typeof value === 'string') {
    if (key && TOOL_SCHEMA_TEXT_KEYS.has(key)) return sanitizeToolText(value);
    if (containsPromptInjectionText(value)) return '';
    return value.slice(0, TOOL_METADATA_MAX_CHARS);
  }
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  return null;
}

export function sanitizeToolInputSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'object', additionalProperties: true };
  }
  const sanitized = sanitizeToolSchemaValue(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : { type: 'object', additionalProperties: true };
}
