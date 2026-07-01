import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import {
  incrementTargetInsightsCheckpointOutcome,
  observeTargetInsightsCheckpointDurationMs,
  recordTargetInsightsCheckpointPatchCount
} from '../../metrics.js';
import { repo } from '../../store/repository.js';
import { withTransaction } from '../../store/repository-transaction.js';
import { TargetType } from '../../types/domain.js';
import { TargetInsightsEntry, TargetInsightsEntryPatch } from '../../types/target-insights.js';
import { isModelAllowedForProvider } from '../llm-policy.js';
import { gatewayTokenService } from '../token-service.js';
import { resolveWorkspaceLlmSettings } from '../workspace-ai-resolution.js';
import { recordTargetInsightsAudit } from './audit.js';
import { normalizeTargetInsightsConfig } from './config.js';

interface TargetInsightPatch {
  action: 'create' | 'update' | 'archive' | 'noop';
  entryId?: string;
  title?: string;
  status?: 'active' | 'pending' | 'archived';
  bodyMarkdown?: string;
  tags?: string[];
  evidenceSummary?: string;
  observationCount?: number;
  confidence?: number;
  signals?: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

const GENERALIZABLE_SCOPE_KEYS = new Set(['namespace', 'namespaces', 'pod', 'pods', 'node', 'nodes', 'host', 'hosts']);

function tokenize(value: string | undefined): Set<string> {
  return new Set((value || '').toLowerCase().split(/[^a-z0-9_.-]+/).filter((token) => token.length >= 3));
}

function flattenSignalTerms(value: Record<string, unknown> | undefined): Set<string> {
  const terms = new Set<string>();
  for (const [key, item] of Object.entries(value || {})) {
    terms.add(key.toLowerCase());
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      terms.add(String(item).toLowerCase());
    }
  }
  return terms;
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function findGeneralizationTarget(patch: TargetInsightPatch, entries: TargetInsightsEntry[]): TargetInsightsEntry | null {
  const patchTitleTerms = tokenize(patch.title);
  const patchTags = new Set((patch.tags || []).map((tag) => tag.toLowerCase()));
  const patchSignals = flattenSignalTerms(patch.signals);
  let best: { entry: TargetInsightsEntry; score: number } | null = null;
  for (const entry of entries) {
    if (entry.status === 'archived') continue;
    const tagOverlap = overlapCount(patchTags, new Set(entry.tags.map((tag) => tag.toLowerCase())));
    const signalOverlap = overlapCount(patchSignals, flattenSignalTerms(entry.signals));
    const titleOverlap = overlapCount(patchTitleTerms, tokenize(entry.title));
    const score = tagOverlap * 2 + signalOverlap * 3 + titleOverlap;
    if (score >= 5 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best?.entry || null;
}

function mergeScope(existing: Record<string, unknown>, incoming: Record<string, unknown> | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming || {})) {
    const existingValue = merged[key];
    if (existingValue === undefined || JSON.stringify(existingValue) === JSON.stringify(value)) {
      merged[key] = value;
      continue;
    }
    if (GENERALIZABLE_SCOPE_KEYS.has(key.toLowerCase())) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeEvidenceSummary(existing: string, incoming: string | undefined): string {
  const trimmedIncoming = (incoming || '').trim();
  if (!trimmedIncoming) return existing;
  if (!existing.trim()) return trimmedIncoming;
  if (existing.toLowerCase().includes(trimmedIncoming.toLowerCase())) return existing;
  return `${existing.trim()} ${trimmedIncoming}`.slice(0, 4096);
}

function buildGeneralizedUpdate(
  entry: TargetInsightsEntry,
  patch: TargetInsightPatch,
  minimumObservationsBeforeGeneralization: number,
  lastObservedAt: string
): TargetInsightsEntryPatch {
  const observationCount = Math.max(entry.observationCount + 1, patch.observationCount || 0);
  return {
    ...(patch.title ? { title: patch.title } : {}),
    ...(patch.bodyMarkdown ? { bodyMarkdown: patch.bodyMarkdown } : {}),
    status: observationCount >= minimumObservationsBeforeGeneralization ? 'active' : entry.status,
    tags: [...new Set([...entry.tags, ...(patch.tags || [])].map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
    evidenceSummary: mergeEvidenceSummary(entry.evidenceSummary, patch.evidenceSummary),
    observationCount,
    confidence: Math.max(entry.confidence, patch.confidence ?? 0),
    signals: { ...entry.signals, ...(patch.signals || {}) },
    scope: mergeScope(entry.scope, patch.scope),
    lastObservedAt
  };
}

function parseGatewayStreamLine(line: string): string {
  const chunk = JSON.parse(line) as { type?: string; text?: string; code?: string; message?: string };
  if (chunk.type === 'delta' && typeof chunk.text === 'string') {
    return chunk.text;
  }
  if (chunk.type === 'error') {
    throw new Error(chunk.message || chunk.code || 'llm-gateway stream error');
  }
  return '';
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) || trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}

function normalizePatch(value: unknown): TargetInsightPatch[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { patches?: unknown }).patches)
      ? (value as { patches: unknown[] }).patches
      : [];
  return items.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const patch = item as TargetInsightPatch;
    if (!['create', 'update', 'archive', 'noop'].includes(patch.action)) return [];
    return [{
      action: patch.action,
      entryId: typeof patch.entryId === 'string' ? patch.entryId : undefined,
      title: typeof patch.title === 'string' ? patch.title.slice(0, 240) : undefined,
      status: patch.status === 'active' || patch.status === 'pending' || patch.status === 'archived' ? patch.status : undefined,
      bodyMarkdown: typeof patch.bodyMarkdown === 'string' ? patch.bodyMarkdown.slice(0, 32768) : undefined,
      tags: Array.isArray(patch.tags) ? patch.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
      evidenceSummary: typeof patch.evidenceSummary === 'string' ? patch.evidenceSummary.slice(0, 4096) : undefined,
      observationCount: typeof patch.observationCount === 'number' ? Math.max(0, Math.floor(patch.observationCount)) : undefined,
      confidence: typeof patch.confidence === 'number' ? Math.max(0, Math.min(1, patch.confidence)) : undefined,
      signals: patch.signals && typeof patch.signals === 'object' && !Array.isArray(patch.signals) ? patch.signals : undefined,
      scope: patch.scope && typeof patch.scope === 'object' && !Array.isArray(patch.scope) ? patch.scope : undefined
    }];
  });
}

async function streamGatewayJsonPatch(input: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  sessionId: string;
  provider: string;
  model: string;
  allowedProviders: string[];
  allowedModels: string[];
  transcript: string;
  existingEntries: Array<{ id: string; title: string; status: string; evidenceSummary: string }>;
}): Promise<TargetInsightPatch[]> {
  const checkpointRunId = randomUUID();
  const token = await gatewayTokenService.signRunScopeToken({
    runId: checkpointRunId,
    workspaceId: input.workspaceId,
    targetId: input.targetId,
    targetType: input.targetType,
    sessionId: input.sessionId,
    allowedProviders: input.allowedProviders,
    allowedModels: input.allowedModels,
    allowedTools: [],
    allowedNativeTools: [],
    allowedToolOperations: {},
    maxOutputTokens: Math.min(config.LLM_MAX_OUTPUT_TOKENS || 2048, 4096)
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.LLM_GATEWAY_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.LLM_GATEWAY_URL}/api/v1/llm/generations:stream`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        run_id: checkpointRunId,
        workspace_id: input.workspaceId,
        target_id: input.targetId,
        target_type: input.targetType,
        session_id: input.sessionId,
        provider: input.provider,
        model: input.model,
        temperature: 0,
        max_output_tokens: Math.min(config.LLM_MAX_OUTPUT_TOKENS || 2048, 4096),
        reasoning: { summary_mode: 'off', effort: 'low' },
        messages: [
          {
            role: 'system',
            content: [
              'You update AcornOps Target Insights entries for future troubleshooting.',
              'Return only JSON: {"patches":[...]} with actions create, update, archive, or noop.',
              'Generalize repeated namespace/host-specific issues into broader fixes when evidence supports it.',
              'Do not include run IDs or raw logs. Use concise evidence summaries.'
            ].join(' ')
          },
          {
            role: 'user',
            content: JSON.stringify({
              existingEntries: input.existingEntries,
              transcript: input.transcript
            })
          }
        ]
      })
    });
    if (!response.ok || !response.body) {
      throw new Error(`llm-gateway returned ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        text += parseGatewayStreamLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      text += parseGatewayStreamLine(buffer);
    }
    return normalizePatch(extractJson(text));
  } finally {
    clearTimeout(timeout);
  }
}

function jobKey(job: Awaited<ReturnType<typeof repo.claimDueTargetInsightsCheckpointJobs>>[number]) {
  return {
    workspaceId: job.workspaceId,
    targetId: job.targetId,
    sessionId: job.sessionId,
    lastActivityAt: job.lastActivityAt,
    leaseOwner: job.leaseOwner
  };
}

async function finishJob(
  job: Awaited<ReturnType<typeof repo.claimDueTargetInsightsCheckpointJobs>>[number],
  params: { status: string; error?: string | null; retryAfter?: string | null }
): Promise<void> {
  await repo.finishTargetInsightsCheckpointJob({
    ...jobKey(job),
    status: params.status,
    error: params.error,
    retryAfter: params.retryAfter
  });
}

async function rescheduleJob(
  job: Awaited<ReturnType<typeof repo.claimDueTargetInsightsCheckpointJobs>>[number],
  dueAt: string,
  error?: string
): Promise<void> {
  await repo.rescheduleTargetInsightsCheckpointJob({
    ...jobKey(job),
    dueAt,
    error
  });
}

async function processJob(job: Awaited<ReturnType<typeof repo.claimDueTargetInsightsCheckpointJobs>>[number]): Promise<void> {
  const toolConfig = normalizeTargetInsightsConfig(job.config);
  if (!job.sessionActive) {
    await finishJob(job, { status: 'skipped', error: 'session_inactive' });
    incrementTargetInsightsCheckpointOutcome('skipped', 'session_inactive');
    return;
  }
  if (!job.toolEnabled) {
    await finishJob(job, { status: 'skipped', error: 'tool_disabled' });
    incrementTargetInsightsCheckpointOutcome('skipped', 'tool_disabled');
    return;
  }
  if (new Date(job.sessionLastMessageAt).getTime() > new Date(job.lastActivityAt).getTime()) {
    await repo.upsertTargetInsightsCheckpointJobForSessionActivity(job.sessionId, job.sessionLastMessageAt);
    incrementTargetInsightsCheckpointOutcome('skipped', 'stale_activity');
    return;
  }
  const retryAfterMs = new Date(job.lastActivityAt).getTime() +
    toolConfig.learning.idleCheckpointDelayMinutes * 60_000;
  if (Date.now() < retryAfterMs) {
    await rescheduleJob(job, new Date(retryAfterMs).toISOString(), 'idle_delay_pending');
    incrementTargetInsightsCheckpointOutcome('skipped', 'idle_delay_pending');
    return;
  }
  if (job.hasActiveRun || job.hasPendingApproval) {
    await rescheduleJob(job, new Date(Date.now() + 60_000).toISOString(), job.hasActiveRun ? 'run_active' : 'approval_pending');
    incrementTargetInsightsCheckpointOutcome('skipped', job.hasActiveRun ? 'run_active' : 'approval_pending');
    return;
  }
  const snapshot = toolConfig.learning.checkpointModel.mode === 'custom'
    ? {
        provider: toolConfig.learning.checkpointModel.provider,
        model: toolConfig.learning.checkpointModel.model,
        reasoningSummaryMode: 'off' as const,
        reasoningEffort: 'low' as const
      }
    : { reasoningSummaryMode: 'off' as const, reasoningEffort: 'low' as const };
  const llmSettings = await resolveWorkspaceLlmSettings(job.workspaceId, snapshot);
  const skipReason = !llmSettings.allowedProviders.includes(llmSettings.provider)
    ? 'provider_not_allowed'
    : !llmSettings.allowedModels.includes(llmSettings.model) || !isModelAllowedForProvider(llmSettings.provider, llmSettings.model, llmSettings.allowedProviderModels)
      ? 'model_not_allowed'
      : !llmSettings.credentialConfigured
        ? 'ai_settings_missing'
        : null;
  if (skipReason) {
    await finishJob(job, { status: 'skipped', error: skipReason });
    await recordTargetInsightsAudit({
      workspaceId: job.workspaceId,
      targetId: job.targetId,
      targetType: job.targetType,
      actorType: 'system',
      eventType: 'target_insights.checkpoint.skipped.v1',
      objectId: job.targetId,
      summary: 'Target Insights checkpoint skipped',
      metadata: { reason: skipReason, sessionId: job.sessionId }
    });
    incrementTargetInsightsCheckpointOutcome('skipped', skipReason);
    return;
  }

  const messages = await repo.listMessages(job.sessionId, { limit: 80 });
  const transcript = messages.items.map((message) => `${message.role}: ${message.content}`).join('\n\n').slice(-24000);
  const existingEntries = await repo.listTargetInsightsEntries(job.workspaceId, job.targetId, { limit: 80 });
  const patches = await streamGatewayJsonPatch({
    workspaceId: job.workspaceId,
    targetId: job.targetId,
    targetType: job.targetType,
    sessionId: job.sessionId,
    provider: llmSettings.provider,
    model: llmSettings.model,
    allowedProviders: llmSettings.allowedProviders,
    allowedModels: llmSettings.allowedModels,
    transcript,
    existingEntries: existingEntries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      evidenceSummary: entry.evidenceSummary
    }))
  });
  let applied = 0;
  const terminalStatus = await withTransaction(async (client) => {
    if (!(await repo.renewTargetInsightsCheckpointJobLeaseIfCurrent(jobKey(job), client))) {
      return null;
    }

    for (const patch of patches) {
      if (patch.action === 'noop') continue;
      if (patch.action === 'create' && patch.title && patch.bodyMarkdown) {
        const generalizationTarget = findGeneralizationTarget(patch, existingEntries);
        if (generalizationTarget) {
          const updated = await repo.updateTargetInsightsEntry(
            job.workspaceId,
            job.targetId,
            generalizationTarget.id,
            buildGeneralizedUpdate(
              generalizationTarget,
              patch,
              toolConfig.learning.minimumObservationsBeforeGeneralization,
              job.lastActivityAt
            ),
            client
          );
          if (updated) {
            applied += 1;
            const index = existingEntries.findIndex((entry) => entry.id === updated.id);
            if (index >= 0) existingEntries[index] = updated;
          }
        } else {
          const status = (patch.observationCount || 0) >= toolConfig.learning.minimumObservationsBeforeGeneralization
            ? 'active'
            : patch.status || 'pending';
          const created = await repo.createTargetInsightsEntry({
            workspaceId: job.workspaceId,
            targetId: job.targetId,
            targetType: job.targetType,
            title: patch.title,
            status,
            bodyMarkdown: patch.bodyMarkdown,
            tags: patch.tags,
            evidenceSummary: patch.evidenceSummary,
            observationCount: patch.observationCount,
            confidence: patch.confidence,
            signals: patch.signals,
            scope: patch.scope,
            firstObservedAt: job.lastActivityAt,
            lastObservedAt: job.lastActivityAt
          }, client);
          existingEntries.unshift(created);
          applied += 1;
        }
      } else if ((patch.action === 'update' || patch.action === 'archive') && patch.entryId) {
        const existingEntry = existingEntries.find((entry) => entry.id === patch.entryId);
        const observationCount = patch.observationCount !== undefined
          ? Math.max(existingEntry?.observationCount ?? 0, patch.observationCount)
          : undefined;
        const confidence = patch.confidence !== undefined
          ? Math.max(existingEntry?.confidence ?? 0, patch.confidence)
          : undefined;
        const nextStatus = patch.action === 'archive'
          ? 'archived'
          : (observationCount || 0) >= toolConfig.learning.minimumObservationsBeforeGeneralization
            ? 'active'
            : patch.status;
        const updated = await repo.updateTargetInsightsEntry(job.workspaceId, job.targetId, patch.entryId, {
          ...(patch.title ? { title: patch.title } : {}),
          ...(patch.bodyMarkdown ? { bodyMarkdown: patch.bodyMarkdown } : {}),
          ...(nextStatus ? { status: nextStatus } : {}),
          ...(patch.tags ? { tags: patch.tags } : {}),
          ...(patch.evidenceSummary ? { evidenceSummary: patch.evidenceSummary } : {}),
          ...(observationCount !== undefined ? { observationCount } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(patch.signals ? { signals: patch.signals } : {}),
          ...(patch.scope ? { scope: patch.scope } : {}),
          lastObservedAt: job.lastActivityAt
        }, client);
        if (updated) {
          applied += 1;
          const index = existingEntries.findIndex((entry) => entry.id === updated.id);
          if (index >= 0) existingEntries[index] = updated;
        }
      }
    }

    const status = applied > 0 ? 'applied' : 'noop';
    const finished = await repo.finishTargetInsightsCheckpointJob({
      ...jobKey(job),
      status
    }, client);
    if (!finished) {
      throw new Error('Target Insights checkpoint lease expired before finish');
    }
    return status;
  });

  if (!terminalStatus) {
    await rescheduleJob(job, new Date(Date.now() + 60_000).toISOString(), 'state_changed');
    incrementTargetInsightsCheckpointOutcome('skipped', 'state_changed');
    return;
  }
  incrementTargetInsightsCheckpointOutcome(terminalStatus);
  recordTargetInsightsCheckpointPatchCount(terminalStatus, applied);
  await recordTargetInsightsAudit({
    workspaceId: job.workspaceId,
    targetId: job.targetId,
    targetType: job.targetType,
    actorType: 'system',
    eventType: 'target_insights.checkpoint.applied.v1',
    objectId: job.targetId,
    summary: applied > 0 ? 'Target Insights checkpoint applied' : 'Target Insights checkpoint completed with no changes',
    metadata: { sessionId: job.sessionId, appliedPatchCount: applied }
  });
}

export async function runTargetInsightsCheckpointSweep(): Promise<void> {
  if (!config.TARGET_INSIGHTS_ENABLED) return;
  const leaseOwner = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;
  const claimedKeys = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const [job] = await repo.claimDueTargetInsightsCheckpointJobs(1, leaseOwner);
    if (!job) break;
    const claimedKey = `${job.workspaceId}:${job.targetId}:${job.sessionId}:${job.lastActivityAt}`;
    if (claimedKeys.has(claimedKey)) break;
    claimedKeys.add(claimedKey);
    const startedAt = Date.now();
    let status = 'unknown';
    try {
      await processJob(job);
      status = 'completed';
    } catch (err) {
      status = 'failed';
      logger.warn({ err, targetId: job.targetId, sessionId: job.sessionId }, 'Target Insights checkpoint failed');
      await repo.finishTargetInsightsCheckpointJob({
        ...jobKey(job),
        status: 'failed',
        error: err instanceof Error ? err.message : 'Target Insights checkpoint failed',
        retryAfter: new Date(Date.now() + 15 * 60_000).toISOString()
      });
      incrementTargetInsightsCheckpointOutcome('failed', 'exception');
    } finally {
      observeTargetInsightsCheckpointDurationMs(status, Date.now() - startedAt);
    }
  }
}
