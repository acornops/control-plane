import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import {
  KnowledgeBankEntry,
  KnowledgeBankEntryInput,
  KnowledgeBankEntryPatch,
  KnowledgeBankEntryStatus,
  KnowledgeBankSnippet
} from '../types/knowledge-bank.js';
import { TargetType } from '../types/domain.js';

type Queryable = Pick<typeof db, 'query'> | PoolClient;

interface KnowledgeBankEntryRow {
  id: string;
  workspace_id: string;
  target_id: string;
  target_type: TargetType;
  title: string;
  status: KnowledgeBankEntryStatus;
  body_markdown: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  signals: Record<string, unknown>;
  scope: Record<string, unknown>;
  evidence_summary: string;
  observation_count: number;
  confidence: string | number;
  first_observed_at: Date | null;
  last_observed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapEntry(row: KnowledgeBankEntryRow): KnowledgeBankEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    title: row.title,
    status: row.status,
    bodyMarkdown: row.body_markdown,
    frontmatter: row.frontmatter || {},
    tags: row.tags || [],
    signals: row.signals || {},
    scope: row.scope || {},
    evidenceSummary: row.evidence_summary || '',
    observationCount: Number(row.observation_count || 0),
    confidence: Number(row.confidence || 0),
    firstObservedAt: iso(row.first_observed_at),
    lastObservedAt: iso(row.last_observed_at),
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at) || ''
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags || []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 32);
}

export async function listKnowledgeBankEntries(
  workspaceId: string,
  targetId: string,
  options: { status?: KnowledgeBankEntryStatus; q?: string; limit?: number } = {}
): Promise<KnowledgeBankEntry[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));
  const params: Array<string | number> = [workspaceId, targetId, limit];
  const clauses = ['workspace_id = $1', 'target_id = $2'];
  if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }
  if (options.q?.trim()) {
    params.push(`%${options.q.trim().toLowerCase()}%`);
    clauses.push(`(LOWER(title) LIKE $${params.length} OR LOWER(body_markdown) LIKE $${params.length} OR LOWER(evidence_summary) LIKE $${params.length})`);
  }
  const result = await db.query(
    `SELECT *
     FROM target_knowledge_entries
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT $3`,
    params
  );
  return (result.rows as KnowledgeBankEntryRow[]).map(mapEntry);
}

export async function getKnowledgeBankEntry(
  workspaceId: string,
  targetId: string,
  entryId: string,
  queryable: Queryable = db
): Promise<KnowledgeBankEntry | null> {
  const result = await queryable.query(
    `SELECT *
     FROM target_knowledge_entries
     WHERE workspace_id = $1 AND target_id = $2 AND id = $3`,
    [workspaceId, targetId, entryId]
  );
  return result.rows[0] ? mapEntry(result.rows[0] as KnowledgeBankEntryRow) : null;
}

export async function createKnowledgeBankEntry(input: KnowledgeBankEntryInput, queryable: Queryable = db): Promise<KnowledgeBankEntry> {
  const id = randomUUID();
  const result = await queryable.query(
    `INSERT INTO target_knowledge_entries (
       id, workspace_id, target_id, target_type, title, status, body_markdown,
       frontmatter, tags, signals, scope, evidence_summary, observation_count,
       confidence, first_observed_at, last_observed_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[], $10::jsonb,
       $11::jsonb, $12, $13, $14, $15::timestamptz, $16::timestamptz, NOW(), NOW()
     )
     RETURNING *`,
    [
      id,
      input.workspaceId,
      input.targetId,
      input.targetType,
      input.title,
      input.status,
      input.bodyMarkdown,
      JSON.stringify(input.frontmatter || {}),
      normalizeTags(input.tags),
      JSON.stringify(input.signals || {}),
      JSON.stringify(input.scope || {}),
      input.evidenceSummary || '',
      input.observationCount ?? 0,
      input.confidence ?? 0,
      input.firstObservedAt || null,
      input.lastObservedAt || null
    ]
  );
  return mapEntry(result.rows[0] as KnowledgeBankEntryRow);
}

export async function updateKnowledgeBankEntry(
  workspaceId: string,
  targetId: string,
  entryId: string,
  patch: KnowledgeBankEntryPatch,
  queryable: Queryable = db
): Promise<KnowledgeBankEntry | null> {
  const current = await getKnowledgeBankEntry(workspaceId, targetId, entryId, queryable);
  if (!current) return null;
  const next = {
    title: patch.title ?? current.title,
    status: patch.status ?? current.status,
    bodyMarkdown: patch.bodyMarkdown ?? current.bodyMarkdown,
    frontmatter: patch.frontmatter ?? current.frontmatter,
    tags: normalizeTags(patch.tags ?? current.tags),
    signals: patch.signals ?? current.signals,
    scope: patch.scope ?? current.scope,
    evidenceSummary: patch.evidenceSummary ?? current.evidenceSummary,
    observationCount: patch.observationCount ?? current.observationCount,
    confidence: patch.confidence ?? current.confidence,
    firstObservedAt: patch.firstObservedAt === undefined ? current.firstObservedAt || null : patch.firstObservedAt,
    lastObservedAt: patch.lastObservedAt === undefined ? current.lastObservedAt || null : patch.lastObservedAt
  };
  const result = await queryable.query(
    `UPDATE target_knowledge_entries
     SET title = $4,
         status = $5,
         body_markdown = $6,
         frontmatter = $7::jsonb,
         tags = $8::text[],
         signals = $9::jsonb,
         scope = $10::jsonb,
         evidence_summary = $11,
         observation_count = $12,
         confidence = $13,
         first_observed_at = $14::timestamptz,
         last_observed_at = $15::timestamptz,
         updated_at = NOW()
     WHERE workspace_id = $1 AND target_id = $2 AND id = $3
     RETURNING *`,
    [
      workspaceId,
      targetId,
      entryId,
      next.title,
      next.status,
      next.bodyMarkdown,
      JSON.stringify(next.frontmatter),
      next.tags,
      JSON.stringify(next.signals),
      JSON.stringify(next.scope),
      next.evidenceSummary,
      next.observationCount,
      next.confidence,
      next.firstObservedAt,
      next.lastObservedAt
    ]
  );
  return result.rows[0] ? mapEntry(result.rows[0] as KnowledgeBankEntryRow) : null;
}

export async function resetKnowledgeBank(workspaceId: string, targetId: string): Promise<{ deletedEntries: number; deletedCheckpoints: number }> {
  const entries = await db.query(
    'DELETE FROM target_knowledge_entries WHERE workspace_id = $1 AND target_id = $2',
    [workspaceId, targetId]
  );
  const checkpoints = await db.query(
    'DELETE FROM target_knowledge_checkpoint_jobs WHERE workspace_id = $1 AND target_id = $2',
    [workspaceId, targetId]
  );
  return {
    deletedEntries: entries.rowCount ?? 0,
    deletedCheckpoints: checkpoints.rowCount ?? 0
  };
}

export async function searchKnowledgeBankSnippets(
  workspaceId: string,
  targetId: string,
  query: string,
  options: { limit: number; maxSnippetSizeBytes: number }
): Promise<KnowledgeBankSnippet[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const limit = Math.max(1, Math.min(8, options.limit));
  const maxBytes = Math.max(512, Math.min(4096, options.maxSnippetSizeBytes));
  const queryTerms = [
    ...new Set(trimmed.toLowerCase().split(/[^a-z0-9_.-]+/).filter((term) => term.length >= 2))
  ].slice(0, 64);
  const result = await db.query<KnowledgeBankEntryRow & {
    rank: string | number;
    tag_overlap: string | number;
    signal_overlap: string | number;
    scope_overlap: string | number;
    scope_specificity: string | number;
  }>(
    `WITH search AS (
       SELECT plainto_tsquery('simple', $3) AS query, $5::text[] AS terms
     ),
     entries AS (
       SELECT
         e.*,
         to_tsvector('simple', e.title || ' ' || e.body_markdown || ' ' || e.evidence_summary) AS search_document,
         LOWER(e.title || ' ' || e.body_markdown || ' ' || e.evidence_summary) AS search_text
       FROM target_knowledge_entries e
       WHERE e.workspace_id = $1
         AND e.target_id = $2
         AND e.status = 'active'
     )
     SELECT e.*,
       ts_rank(e.search_document, search.query) AS rank,
       (
         SELECT COUNT(*)::int
         FROM unnest(e.tags) AS tag
         WHERE tag = ANY(search.terms)
       ) AS tag_overlap,
       (
         SELECT COUNT(*)::int
         FROM jsonb_each_text(e.signals) AS signal(key, value)
         WHERE LOWER(signal.key) = ANY(search.terms)
            OR LOWER(signal.value) = ANY(search.terms)
       ) AS signal_overlap,
       (
         SELECT COUNT(*)::int
         FROM jsonb_each_text(e.scope) AS scope(key, value)
         WHERE LOWER(scope.key) = ANY(search.terms)
            OR LOWER(scope.value) = ANY(search.terms)
       ) AS scope_overlap,
       (
         SELECT COUNT(*)::int
         FROM jsonb_object_keys(e.scope) AS scope_key
       ) AS scope_specificity
     FROM entries e, search
     WHERE e.search_document @@ search.query
        OR e.search_text LIKE '%' || LOWER($3) || '%'
        OR e.tags && search.terms
        OR EXISTS (
          SELECT 1
          FROM jsonb_each_text(e.signals) AS signal(key, value)
          WHERE LOWER(signal.key) = ANY(search.terms)
             OR LOWER(signal.value) = ANY(search.terms)
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_each_text(e.scope) AS scope(key, value)
          WHERE LOWER(scope.key) = ANY(search.terms)
             OR LOWER(scope.value) = ANY(search.terms)
        )
     ORDER BY
       rank DESC,
       tag_overlap DESC,
       signal_overlap DESC,
       scope_overlap DESC,
       e.confidence DESC,
       e.observation_count DESC,
       scope_specificity DESC,
       e.updated_at DESC
     LIMIT $4`,
    [workspaceId, targetId, trimmed, limit, queryTerms.length > 0 ? queryTerms : [trimmed.toLowerCase()]]
  );

  return result.rows.map((row) => {
    const entry = mapEntry(row);
    const source = entry.bodyMarkdown || entry.evidenceSummary;
    const tagOverlap = Number(row.tag_overlap || 0);
    const signalOverlap = Number(row.signal_overlap || 0);
    const scopeOverlap = Number(row.scope_overlap || 0);
    const scopeSpecificity = Number(row.scope_specificity || 0);
    return {
      entryId: entry.id,
      title: entry.title,
      body: Buffer.byteLength(source, 'utf8') > maxBytes
        ? `${Buffer.from(source).subarray(0, maxBytes).toString('utf8').replace(/\s+\S*$/, '')}...`
        : source,
      evidenceSummary: entry.evidenceSummary,
      tags: entry.tags,
      confidence: entry.confidence,
      observationCount: entry.observationCount,
      score: Number(row.rank || 0) +
        (tagOverlap + signalOverlap + scopeOverlap) * 0.2 +
        entry.confidence +
        Math.min(entry.observationCount, 10) / 20 +
        Math.min(scopeSpecificity, 5) / 100,
      updatedAt: entry.updatedAt
    };
  });
}
