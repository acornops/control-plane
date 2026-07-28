import { randomUUID } from 'node:crypto';
import { dispatchRunToExecutionEngine, cancelRunInExecutionEngine } from './execution-engine-client.js';
import { logger } from '../logger.js';
import { type TargetAutoTriageJob } from '../types/auto-triage.js';
import type { Run } from '../types/domain.js';
import { repo } from '../store/repository.js';
import {
  issueMeetsAutoTriageThreshold
} from '../store/repository-auto-triage.js';
import { resolveTargetAutoTriagePreview } from './auto-triage-policy.js';
import { resolveWorkspaceLlmSettings } from './workspace-ai-resolution.js';
import {
  recordRunStatusChangedActivity,
  recordTargetChatActivityEvent
} from './target-chat-activity-events.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import {
  incrementAutoTriageBlocked,
  incrementAutoTriageOutcome,
  incrementAutoTriageRuntimeEvent,
  observeAutoTriageStartLatencyMs,
  setAutoTriageActiveRuns
} from '../metrics-auto-triage.js';
import {
  AutoTriageSettingsChangedError,
  createTargetAutoTriageSessionAndRun
} from './auto-triage-run-creation.js';
import {
  transitionLinkedRunWhileClaimed,
  updateLinkedRunWhileClaimed
} from './auto-triage-run-transitions.js';
import { autoTriageBlockedBackoff } from './auto-triage-retry-timing.js';
import { sanitizeArtifactResult } from './tool-result-artifacts.js';

const AUTO_TRIAGE_MAX_ATTEMPTS = 3;
export const TARGET_AUTO_TRIAGE_WORKER_INTERVAL_MS = 1_000;

function boundedText(value: unknown, max: number): string {
  return [...String(value || '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

function safeInternalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Automatic investigation failed');
  return boundedText(sanitizeArtifactResult(message), 1000);
}

async function auditJob(
  job: TargetAutoTriageJob,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>
): Promise<void> {
  if (eventType.endsWith('_job_started.v1')) {
    incrementAutoTriageOutcome('started');
    observeAutoTriageStartLatencyMs(Math.max(0, Date.now() - Date.parse(job.createdAt)));
  } else if (eventType.endsWith('_job_completed.v1')) {
    incrementAutoTriageOutcome('completed');
  } else if (eventType.endsWith('_job_blocked.v1')) {
    incrementAutoTriageBlocked(String(metadata.errorCode || 'unknown'));
  } else if (eventType.endsWith('_job_failed.v1')) {
    incrementAutoTriageOutcome('failed');
  } else if (eventType.endsWith('_job_skipped.v1')) {
    incrementAutoTriageOutcome('skipped');
  } else if (eventType.endsWith('_session_created.v1')) {
    incrementAutoTriageRuntimeEvent('session_created');
  } else if (eventType.endsWith('_run_stopped.v1')) {
    incrementAutoTriageRuntimeEvent('resolution_stopped');
  }
  await recordWorkspaceAuditEvent({
    workspaceId: job.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorType: 'system',
    objectType: 'target_auto_triage_job',
    objectId: job.id,
    summary,
    metadata: {
      targetId: job.targetId,
      targetType: job.targetType,
      issueId: job.issueId,
      issueLifecycleVersion: job.issueLifecycleVersion,
      triggerReason: job.triggerReason,
      ...metadata
    }
  });
}

async function dispatchLinkedRun(job: TargetAutoTriageJob, run: Run): Promise<void> {
  if (run.status === 'running' || run.status === 'waiting_for_approval') {
    const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner!,
      status: 'started',
      sessionId: run.sessionId,
      runId: run.id
    });
    if (!transitioned) return;
    await auditJob(job, 'target.auto_triage_job_started.v1', 'Automatic investigation started', {
      sessionId: run.sessionId,
      runId: run.id,
      recovered: true
    });
    return;
  }
  if (run.status === 'completed' || run.status === 'cancelled') {
    const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner!,
      status: run.status === 'completed' ? 'completed' : 'skipped',
      sessionId: run.sessionId,
      runId: run.id
    });
    if (!transitioned) return;
    await auditJob(
      job,
      run.status === 'completed'
        ? 'target.auto_triage_job_completed.v1'
        : 'target.auto_triage_job_skipped.v1',
      run.status === 'completed'
        ? 'Automatic investigation completed'
        : 'Automatic investigation stopped',
      { sessionId: run.sessionId, runId: run.id, recovered: true }
    );
    return;
  }
  if (run.status === 'failed') {
    const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner!,
      status: 'failed',
      sessionId: run.sessionId,
      runId: run.id,
      errorCode: run.errorCode || 'RUN_FAILED',
      internalErrorMessage: null
    });
    if (!transitioned) return;
    await auditJob(job, 'target.auto_triage_job_failed.v1', 'Automatic investigation failed', {
      sessionId: run.sessionId,
      runId: run.id,
      errorCode: run.errorCode || 'RUN_FAILED',
      recovered: true
    });
    return;
  }

  const dispatching = await updateLinkedRunWhileClaimed(job, run, { status: 'dispatching' });
  if (!dispatching) return;
  await recordRunStatusChangedActivity(run, dispatching);
  try {
    await dispatchRunToExecutionEngine(dispatching);
    const running = await transitionLinkedRunWhileClaimed(
      job,
      dispatching,
      {
        status: 'running',
        startedAt: run.startedAt || new Date().toISOString(),
        errorCode: undefined,
        errorMessage: undefined
      },
      {
        status: 'started',
        sessionId: run.sessionId,
        runId: run.id
      }
    );
    if (!running) return;
    await recordRunStatusChangedActivity(dispatching, running);
    await auditJob(job, 'target.auto_triage_job_started.v1', 'Automatic investigation started', {
      sessionId: run.sessionId,
      runId: run.id
    });
  } catch (error) {
    const message = safeInternalError(error);
    const exhausted = job.attemptCount >= AUTO_TRIAGE_MAX_ATTEMPTS;
    const nextRun = await transitionLinkedRunWhileClaimed(
      job,
      dispatching,
      exhausted
        ? {
            status: 'failed',
            errorCode: 'DISPATCH_FAILED',
            errorMessage: message,
            endedAt: new Date().toISOString()
          }
        : {
            status: 'queued',
            errorCode: 'DISPATCH_RETRY',
            errorMessage: message
          },
      {
        status: exhausted ? 'failed' : 'blocked',
        sessionId: run.sessionId,
        runId: run.id,
        errorCode: exhausted ? 'DISPATCH_FAILED' : 'DISPATCH_RETRY',
        internalErrorMessage: message,
        nextAttemptAt: exhausted ? undefined : autoTriageBlockedBackoff(job.attemptCount)
      }
    );
    if (!nextRun) return;
    await recordRunStatusChangedActivity(dispatching, nextRun);
    await auditJob(
      job,
      exhausted ? 'target.auto_triage_job_failed.v1' : 'target.auto_triage_job_blocked.v1',
      exhausted ? 'Automatic investigation failed to dispatch' : 'Automatic investigation dispatch will retry',
      { errorCode: exhausted ? 'DISPATCH_FAILED' : 'DISPATCH_RETRY' }
    );
    incrementAutoTriageRuntimeEvent(exhausted ? 'dispatch_failed' : 'dispatch_retry');
  }
}

async function processJob(job: TargetAutoTriageJob): Promise<void> {
  if (!job.leaseOwner) return;

  const [issue, target, settings] = await Promise.all([
    repo.getTargetIssue(job.workspaceId, job.issueId),
    repo.getTarget(job.workspaceId, job.targetId),
    repo.autoTriage.getTargetAutoTriageSettings(job.workspaceId, job.targetId)
  ]);
  if (
    !issue
    || !target
    || issue.lifecycleVersion !== job.issueLifecycleVersion
    || !['active', 'recovering'].includes(issue.status)
    || !settings.enabled
    || !issueMeetsAutoTriageThreshold(issue.severity, settings.minimumSeverity)
  ) {
    let runAndJobTransitioned = false;
    if (job.runId) {
      const existingRun = await repo.getRun(job.runId);
      if (existingRun && ['queued', 'dispatching'].includes(existingRun.status)) {
        const cancelled = await transitionLinkedRunWhileClaimed(
          job,
          existingRun,
          {
            status: 'cancelled',
            endedAt: new Date().toISOString(),
            errorCode: !settings.enabled ? 'AUTO_TRIAGE_DISABLED' : 'ISSUE_NOT_ELIGIBLE',
            errorMessage: 'Automatic investigation was skipped before dispatch.'
          },
          {
            status: 'skipped',
            runId: existingRun.id,
            sessionId: existingRun.sessionId,
            errorCode: !settings.enabled ? 'AUTO_TRIAGE_DISABLED' : 'ISSUE_NOT_ELIGIBLE'
          }
        );
        if (!cancelled) return;
        await recordRunStatusChangedActivity(existingRun, cancelled);
        runAndJobTransitioned = true;
      }
    }
    if (!runAndJobTransitioned) {
      const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
        jobId: job.id,
        leaseOwner: job.leaseOwner,
        status: 'skipped',
        errorCode: !settings.enabled ? 'AUTO_TRIAGE_DISABLED' : 'ISSUE_NOT_ELIGIBLE'
      });
      if (!transitioned) return;
    }
    await auditJob(job, 'target.auto_triage_job_skipped.v1', 'Automatic investigation skipped', {
      errorCode: !settings.enabled ? 'AUTO_TRIAGE_DISABLED' : 'ISSUE_NOT_ELIGIBLE'
    });
    return;
  }

  if (job.runId) {
    const existingRun = await repo.getRun(job.runId);
    if (existingRun) {
      await dispatchLinkedRun(job, existingRun);
      return;
    }
  }

  let preview;
  try {
    preview = await resolveTargetAutoTriagePreview(target, settings.writeMode);
  } catch (error) {
    const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner,
      status: 'blocked',
      errorCode: 'READINESS_CHECK_UNAVAILABLE',
      internalErrorMessage: safeInternalError(error),
      nextAttemptAt: autoTriageBlockedBackoff(job.attemptCount)
    });
    if (!transitioned) return;
    if (job.errorCode !== 'READINESS_CHECK_UNAVAILABLE') {
      await auditJob(
        job,
        'target.auto_triage_job_blocked.v1',
        'Automatic investigation readiness check will retry',
        { errorCode: 'READINESS_CHECK_UNAVAILABLE' }
      );
    }
    return;
  }
  if (preview.readiness.status !== 'ready') {
    const errorCode = preview.readiness.reasons.includes('ai_provider_credentials_missing')
      ? 'AI_PROVIDER_NEEDS_SETUP'
      : preview.readiness.reasons.includes('mcp_tools_need_setup')
        ? 'MCP_TOOLS_NEED_SETUP'
        : preview.readiness.reasons.includes('no_diagnostic_tools')
          ? 'NO_DIAGNOSTIC_TOOLS'
          : 'TARGET_DISCONNECTED';
    const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner,
      status: 'blocked',
      errorCode,
      nextAttemptAt: autoTriageBlockedBackoff(job.attemptCount)
    });
    if (!transitioned) return;
    if (job.errorCode !== errorCode) {
      await auditJob(job, 'target.auto_triage_job_blocked.v1', 'Automatic investigation delayed by readiness', {
        errorCode
      });
    }
    return;
  }

  if (job.attemptCount > 1) {
    const reset = await repo.autoTriage.resetClaimedTargetAutoTriageAttemptCount(
      job.id,
      job.leaseOwner
    );
    if (!reset) return;
    job.attemptCount = 1;
  }

  const llm = await resolveWorkspaceLlmSettings(job.workspaceId);
  let sessionAndRun;
  try {
    sessionAndRun = await createTargetAutoTriageSessionAndRun({
      job,
      issue,
      targetName: target.name,
      settings,
      effective: preview.effectiveBehavior,
      llm
    });
  } catch (error) {
    if (!(error instanceof AutoTriageSettingsChangedError)) throw error;
    await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner,
      status: 'queued',
      nextAttemptAt: new Date().toISOString()
    });
    return;
  }
  const { session, created } = sessionAndRun;
  if (!created.idempotent) {
    await recordTargetChatActivityEvent({
      workspaceId: job.workspaceId,
      targetId: job.targetId,
      targetType: job.targetType,
      sessionId: session.id,
      runId: created.run.id,
      messageId: created.message.id,
      type: 'message.created',
      payload: {
        role: created.message.role,
        kind: created.message.kind,
        automatic: true,
        createdAt: created.message.createdAt
      }
    });
    await recordTargetChatActivityEvent({
      workspaceId: job.workspaceId,
      targetId: job.targetId,
      targetType: job.targetType,
      sessionId: session.id,
      runId: created.run.id,
      messageId: created.message.id,
      type: 'run.created',
      payload: {
        status: created.run.status,
        toolAccessMode: created.run.toolAccessMode,
        automatic: true,
        requestedAt: created.run.requestedAt
      }
    });
    await auditJob(job, 'target.auto_triage_session_created.v1', 'Automatic investigation session and run created', {
      sessionId: session.id,
      runId: created.run.id,
      toolAccessMode: created.run.toolAccessMode,
      confirmationRequiredForWrite: preview.effectiveBehavior.confirmationRequiredForWrite
    });
  }
  await dispatchLinkedRun({ ...job, runId: created.run.id }, created.run);
}

async function processStoppingJob(job: TargetAutoTriageJob): Promise<void> {
  if (!job.leaseOwner || !job.runId) {
    if (job.leaseOwner) {
      const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
        jobId: job.id,
        leaseOwner: job.leaseOwner,
        status: 'skipped',
        errorCode: 'ISSUE_RESOLVED_BEFORE_START'
      });
      if (transitioned) {
        await auditJob(job, 'target.auto_triage_job_skipped.v1', 'Automatic investigation skipped', {
          errorCode: 'ISSUE_RESOLVED_BEFORE_START'
        });
      }
    }
    return;
  }
  const run = await repo.getRun(job.runId);
  if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) {
    const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner,
      status: run?.status === 'completed' ? 'completed' : 'skipped',
      runId: job.runId,
      sessionId: job.sessionId || null,
      errorCode: 'ISSUE_RESOLVED'
    });
    if (!transitioned) return;
    await auditJob(
      job,
      run?.status === 'completed'
        ? 'target.auto_triage_job_completed.v1'
        : 'target.auto_triage_job_skipped.v1',
      run?.status === 'completed'
        ? 'Automatic investigation completed'
        : 'Automatic investigation stopped',
      {
        sessionId: job.sessionId || null,
        runId: job.runId,
        errorCode: 'ISSUE_RESOLVED',
        recovered: true
      }
    );
    return;
  }
  const approvals = await repo.expirePendingRunToolApprovalsForRun(run.id);
  for (const approval of approvals) {
    await recordTargetChatActivityEvent({
      workspaceId: approval.workspaceId,
      targetId: approval.targetId,
      targetType: approval.targetType,
      sessionId: run.sessionId,
      runId: run.id,
      approvalId: approval.id,
      type: 'approval.expired',
      payload: { status: 'expired', reason: 'issue_resolved' }
    });
  }
  try {
    const cancelling = await updateLinkedRunWhileClaimed(job, run, { status: 'cancelling' });
    if (!cancelling) return;
    await recordRunStatusChangedActivity(run, cancelling);
    await cancelRunInExecutionEngine(run.id);
    const cancelled = await transitionLinkedRunWhileClaimed(
      job,
      cancelling,
      {
        status: 'cancelled',
        endedAt: new Date().toISOString(),
        errorCode: 'ISSUE_RESOLVED',
        errorMessage: 'Automatic investigation stopped because the linked issue resolved.'
      },
      {
        status: 'skipped',
        runId: run.id,
        sessionId: run.sessionId,
        errorCode: 'ISSUE_RESOLVED'
      }
    );
    if (!cancelled) return;
    await recordRunStatusChangedActivity(cancelling, cancelled);
    await auditJob(job, 'target.auto_triage_run_stopped.v1', 'Automatic investigation stopped because the issue resolved', {
      sessionId: run.sessionId,
      runId: run.id
    });
  } catch (error) {
    await repo.autoTriage.updateClaimedTargetAutoTriageJob({
      jobId: job.id,
      leaseOwner: job.leaseOwner,
      status: 'stopping',
      runId: run.id,
      sessionId: run.sessionId,
      errorCode: 'CANCELLATION_RETRY',
      internalErrorMessage: safeInternalError(error),
      nextAttemptAt: autoTriageBlockedBackoff(job.attemptCount)
    });
  }
}

export async function runTargetAutoTriageTick(limit = 25): Promise<number> {
  const terminalJobs = await repo.autoTriage.synchronizeTargetAutoTriageTerminalRuns();
  for (const job of terminalJobs) {
    const eventSuffix = job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : 'skipped';
    await auditJob(
      job,
      `target.auto_triage_job_${eventSuffix}.v1`,
      job.status === 'completed'
        ? 'Automatic investigation completed'
        : job.status === 'failed'
          ? 'Automatic investigation failed'
          : 'Automatic investigation stopped',
      { errorCode: job.errorCode || null, sessionId: job.sessionId || null, runId: job.runId || null }
    );
  }
  const leaseOwner = `auto-triage:${randomUUID()}`;
  const stopping = await repo.autoTriage.claimStoppingTargetAutoTriageJobs(leaseOwner, limit);
  for (const job of stopping) {
    try {
      await processStoppingJob(job);
    } catch (error) {
      logger.warn({ error: safeInternalError(error), jobId: job.id }, 'Failed stopping automatic investigation');
    }
  }
  const jobs = await repo.autoTriage.claimDueTargetAutoTriageJobs(leaseOwner, limit);
  for (const job of jobs) {
    try {
      await processJob(job);
    } catch (error) {
      const exhausted = job.attemptCount >= AUTO_TRIAGE_MAX_ATTEMPTS;
      const transitioned = await repo.autoTriage.updateClaimedTargetAutoTriageJob({
        jobId: job.id,
        leaseOwner,
        status: exhausted ? 'failed' : 'blocked',
        errorCode: exhausted ? 'AUTO_TRIAGE_FAILED' : 'AUTO_TRIAGE_RETRY',
        internalErrorMessage: safeInternalError(error),
        nextAttemptAt: exhausted ? undefined : autoTriageBlockedBackoff(job.attemptCount)
      });
      if (!transitioned) continue;
      await auditJob(
        job,
        exhausted ? 'target.auto_triage_job_failed.v1' : 'target.auto_triage_job_blocked.v1',
        exhausted ? 'Automatic investigation failed' : 'Automatic investigation will retry',
        { errorCode: exhausted ? 'AUTO_TRIAGE_FAILED' : 'AUTO_TRIAGE_RETRY' }
      );
      logger.warn({ error: safeInternalError(error), jobId: job.id }, 'Automatic investigation job failed');
    }
  }
  try {
    setAutoTriageActiveRuns(await repo.autoTriage.countActiveTargetAutoTriageRuns());
  } catch (error) {
    logger.warn({ error }, 'Failed refreshing automatic investigation active-run metric');
  }
  return stopping.length + jobs.length;
}
