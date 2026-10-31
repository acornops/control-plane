const TOOL_METADATA_MAX_CHARS = 500;
const TOOL_SCHEMA_MAX_DEPTH = 16;
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

const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas', 'dependencies']);
const SCHEMA_CHILD_KEYS = new Set([
  'additionalProperties', 'additionalItems', 'items', 'contains', 'propertyNames', 'not', 'if', 'then', 'else',
  'unevaluatedItems', 'unevaluatedProperties', 'contentSchema', 'allOf', 'anyOf', 'oneOf', 'prefixItems'
]);
const TOOL_SCHEMA_MAX_BYTES = 262144;

export class ToolSchemaRejectedError extends Error {
  readonly code = 'TOOL_SCHEMA_REJECTED';
  constructor(readonly reason: string, readonly toolName?: string) {
    super(`TOOL_SCHEMA_REJECTED: ${toolName ? `${toolName.slice(0, 128)}: ` : ''}${reason}`);
    this.name = 'ToolSchemaRejectedError';
  }
}

export function sanitizeToolInputSchema(value: unknown, toolName?: string): Record<string, unknown> {
  if (value === undefined || value === null) return { type: 'object', additionalProperties: true };
  function reject(reason: string): never { throw new ToolSchemaRejectedError(reason, toolName); }
  if (typeof value !== 'object' || Array.isArray(value)) reject('expected_object');
  let size = 0;
  let visited = 0;
  const ancestors = new Set<object>();
  function consume(amount: number): void {
    size += amount;
    if (size > TOOL_SCHEMA_MAX_BYTES) reject('byte_limit');
  }
  function scalarSize(item: unknown): number {
    if (typeof item === 'string' && item.length > TOOL_SCHEMA_MAX_BYTES) reject('byte_limit');
    return Buffer.byteLength(JSON.stringify(item), 'utf8');
  }
  function visit(item: unknown, depth: number, context: 'schema' | 'schema_map' | 'literal'): unknown {
    if (depth > TOOL_SCHEMA_MAX_DEPTH) reject('depth_limit');
    if (++visited > 16384) reject('value_limit');
    if (item && typeof item === 'object') {
      if (ancestors.has(item)) reject('cycle');
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        reject('non_json_value');
      }
      const length = Array.isArray(item) ? item.length : Object.keys(item).length;
      if (length > TOOL_SCHEMA_MAX_ITEMS) reject('container_limit');
      consume(2 + Math.max(0, length - 1));
      ancestors.add(item);
      try {
        if (Array.isArray(item)) {
          return Array.from(item, child => visit(child, depth + 1, context === 'schema' ? 'schema' : 'literal'));
        }
        const entries: Array<[string, unknown]> = [];
        for (const [key, child] of Object.entries(item)) {
          consume(scalarSize(key) + 1);
          let childContext: 'schema' | 'schema_map' | 'literal' = 'literal';
          if (context === 'schema_map' && child && typeof child === 'object' && !Array.isArray(child)) {
            childContext = 'schema';
          } else if (context === 'schema') {
            if (SCHEMA_MAP_KEYS.has(key)) childContext = 'schema_map';
            else if (SCHEMA_CHILD_KEYS.has(key)) childContext = 'schema';
          }
          let prepared = visit(child, depth + 1, childContext);
          if (context === 'schema' && TOOL_SCHEMA_TEXT_KEYS.has(key) && typeof child === 'string') {
            prepared = sanitizeToolText(child);
            if (prepared === null) continue;
          }
          entries.push([key, prepared]);
        }
        return Object.fromEntries(entries);
      } finally {
        ancestors.delete(item);
      }
    }
    if ((item !== null && !['string', 'boolean', 'number'].includes(typeof item)) ||
        (typeof item === 'number' && !Number.isFinite(item))) reject('non_json_value');
    consume(scalarSize(item));
    return item;
  }
  return visit(value, 0, 'schema') as Record<string, unknown>;
}
