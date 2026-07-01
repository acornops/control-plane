import { TargetInsightsEntry } from '../../types/target-insights.js';

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

export function serializeTargetInsightsEntryAsMarkdown(entry: TargetInsightsEntry): string {
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

export function serializeTargetInsightsBundle(entries: TargetInsightsEntry[]): string {
  return entries.map((entry) => [
    `# ${entry.title}`,
    '',
    `Path: target-insights/${entry.id}.md`,
    '',
    '```markdown',
    serializeTargetInsightsEntryAsMarkdown(entry),
    '```'
  ].join('\n')).join('\n\n');
}
