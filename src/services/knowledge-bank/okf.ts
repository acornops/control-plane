import { KnowledgeBankEntry } from '../../types/knowledge-bank.js';

function yamlScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value ?? ''));
}

function yamlObject(value: Record<string, unknown>, indent = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    if (Array.isArray(item)) {
      return item.length
        ? [`${indent}${key}:`, ...item.map((entry) => `${indent}  - ${yamlScalar(entry)}`)]
        : [`${indent}${key}: []`];
    }
    if (item && typeof item === 'object') {
      const nested = yamlObject(item as Record<string, unknown>, `${indent}  `);
      return nested.length ? [`${indent}${key}:`, ...nested] : [`${indent}${key}: {}`];
    }
    return [`${indent}${key}: ${yamlScalar(item)}`];
  });
}

export function serializeKnowledgeBankEntryAsMarkdown(entry: KnowledgeBankEntry): string {
  const frontmatter = {
    title: entry.title,
    status: entry.status,
    tags: entry.tags,
    scope: entry.scope,
    signals: entry.signals,
    evidence_summary: entry.evidenceSummary,
    observation_count: entry.observationCount,
    confidence: entry.confidence,
    first_observed_at: entry.firstObservedAt || null,
    last_observed_at: entry.lastObservedAt || null,
    ...entry.frontmatter
  };
  return [
    '---',
    ...yamlObject(frontmatter),
    '---',
    '',
    entry.bodyMarkdown
  ].join('\n');
}

export function serializeKnowledgeBankBundle(entries: KnowledgeBankEntry[]): string {
  return entries.map((entry) => [
    `# ${entry.title}`,
    '',
    `Path: knowledge-bank/${entry.id}.md`,
    '',
    '```markdown',
    serializeKnowledgeBankEntryAsMarkdown(entry),
    '```'
  ].join('\n')).join('\n\n');
}
