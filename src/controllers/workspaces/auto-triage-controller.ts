import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/middleware.js';
import {
  requireWorkspaceCapability,
  requireWorkspaceDataRead
} from '../../auth/workspace-authorization.js';
import { getTargetAutoTriageSettingsPreview } from '../../services/auto-triage-policy.js';
import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { incrementAutoTriageOutcome } from '../../metrics-auto-triage.js';
import { repo } from '../../store/repository.js';
import {
  skipUnstartedTargetAutoTriageJobs,
  startSingleTargetAutoTriageIssue
} from '../../store/repository-auto-triage-manual-actions.js';
import { issueMeetsAutoTriageThreshold } from '../../store/repository-auto-triage.js';
import {
  AUTO_TRIAGE_INSTRUCTIONS_MAX_CHARACTERS,
  normalizeAutoTriageInstructions
} from '../../utils/auto-triage-instructions.js';
import { toSingleParam } from '../../utils/params.js';

async function requireTarget(
  workspaceId: string,
  targetId: string,
  res: Response
) {
  const target = await repo.getTarget(workspaceId, targetId);
  if (!target) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
    return null;
  }
  return target;
}

async function automaticInvestigationForIssue(workspaceId: string, issueId: string) {
  const activity = await repo.autoTriage.getAutomaticInvestigationActivityByIssueIds(workspaceId, [issueId]);
  const summary = activity.get(issueId);
  if (!summary) throw new Error('Automatic investigation activity was not persisted');
  return summary;
}

export async function getTargetAutoTriage(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz || !(await requireTarget(workspaceId, targetId, res))) return;
    const view = await getTargetAutoTriageSettingsPreview(
      workspaceId,
      targetId,
      req.auth.credential.type !== 'external_integration' && authz.can('manage_targets')
    );
    if (!view) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
      return;
    }
    res.status(200).json(view);
  } catch (error) {
    next(error);
  }
}

export async function updateTargetAutoTriage(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const authz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_targets',
      'Only workspace roles with target management capability can edit auto-triage settings'
    );
    const target = authz ? await requireTarget(workspaceId, targetId, res) : null;
    if (!authz || !target) return;
    if (
      req.body.writeMode !== 'read_only'
      && !authz.can('create_read_write_runs')
    ) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Write-capable auto-triage modes require permission to create read/write runs',
          retryable: false
        }
      });
      return;
    }
    const additionalInstructions = normalizeAutoTriageInstructions(req.body.additionalInstructions);
    if ([...additionalInstructions].length > AUTO_TRIAGE_INSTRUCTIONS_MAX_CHARACTERS) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Additional instructions must be 4,000 characters or fewer',
          retryable: false
        }
      });
      return;
    }
    const previous = await repo.autoTriage.getTargetAutoTriageSettings(workspaceId, targetId);
    const saved = await repo.autoTriage.saveTargetAutoTriageSettings({
      workspaceId,
      targetId,
      expectedRevision: req.body.expectedRevision,
      enabled: req.body.enabled,
      minimumSeverity: req.body.minimumSeverity,
      writeMode: req.body.writeMode,
      additionalInstructions,
      updatedBy: req.auth.userId
    });
    if (!saved) {
      res.status(409).json({
        error: {
          code: 'AUTO_TRIAGE_SETTINGS_CONFLICT',
          message: 'Auto-triage settings changed while you were editing. Reload the current settings and try again.',
          retryable: true
        }
      });
      return;
    }
    const skippedJobs = saved.enabled
      ? []
      : await skipUnstartedTargetAutoTriageJobs(workspaceId, targetId);
    for (const job of skippedJobs) {
      incrementAutoTriageOutcome('skipped');
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'run',
        eventType: 'target.auto_triage_job_skipped.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        objectType: 'target_auto_triage_job',
        objectId: job.id,
        summary: 'Unstarted automatic investigation skipped because auto-triage was disabled',
        metadata: {
          targetId,
          targetType: job.targetType,
          issueId: job.issueId,
          issueLifecycleVersion: job.issueLifecycleVersion,
          errorCode: 'AUTO_TRIAGE_DISABLED'
        }
      });
    }
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'target.auto_triage_settings_changed.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: target.targetType,
      objectId: target.id,
      objectName: target.name,
      summary: 'Target auto-triage settings changed',
      metadata: {
        previous: {
          enabled: previous.enabled,
          minimumSeverity: previous.minimumSeverity,
          writeMode: previous.writeMode,
          additionalInstructionsLength: [...previous.additionalInstructions].length
        },
        next: {
          enabled: saved.enabled,
          minimumSeverity: saved.minimumSeverity,
          writeMode: saved.writeMode,
          additionalInstructionsLength: [...saved.additionalInstructions].length
        },
        instructionsChanged: previous.additionalInstructions !== saved.additionalInstructions,
        revision: saved.revision
      }
    });
    const view = await getTargetAutoTriageSettingsPreview(workspaceId, targetId, true);
    res.status(200).json(view);
  } catch (error) {
    next(error);
  }
}

export async function startExistingTargetAutoTriageInvestigations(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const authz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_targets',
      'Only workspace roles with target management capability can start automatic investigations'
    );
    const target = authz ? await requireTarget(workspaceId, targetId, res) : null;
    if (!authz || !target) return;
    const settings = await repo.autoTriage.getTargetAutoTriageSettings(workspaceId, targetId);
    if (settings.writeMode !== 'read_only' && !authz.can('create_read_write_runs')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'The saved auto-triage mode requires permission to create read/write runs',
          retryable: false
        }
      });
      return;
    }
    const result = await repo.autoTriage.enqueueCurrentTargetAutoTriageIssues({
      workspaceId,
      targetId,
      expectedSettingsRevision: req.body.expectedSettingsRevision
    });
    if (!result) {
      res.status(409).json({
        error: {
          code: 'AUTO_TRIAGE_SETTINGS_CONFLICT',
          message: 'Auto-triage must be enabled at the current settings revision before starting existing issues.',
          retryable: true
        }
      });
      return;
    }
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'target.auto_triage_existing_issues_queued.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: target.targetType,
      objectId: target.id,
      objectName: target.name,
      summary: 'Existing target issues queued for automatic investigation',
      metadata: result
    });
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
}

export async function startOrRetryIssueAutomaticInvestigation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const issueId = toSingleParam(req.params.issueId);
    const authz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_targets',
      'Only workspace roles with target management capability can retry automatic investigations'
    );
    if (!authz) return;
    const issue = await repo.getTargetIssue(workspaceId, issueId);
    if (!issue) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Issue not found', retryable: false } });
      return;
    }
    const settings = await repo.autoTriage.getTargetAutoTriageSettings(workspaceId, issue.targetId);
    const existing = await repo.autoTriage.getTargetAutoTriageJobForIssueLifecycle(
      workspaceId,
      issueId,
      issue.lifecycleVersion
    );
    if (existing && existing.status !== 'failed') {
      res.status(200).json(await automaticInvestigationForIssue(workspaceId, issueId));
      return;
    }
    if (existing) {
      const currentActivity = await automaticInvestigationForIssue(workspaceId, issueId);
      if (!currentActivity.canRetry) {
        res.status(200).json(currentActivity);
        return;
      }
    }
    if (!settings.enabled) {
      res.status(409).json({
        error: { code: 'AUTO_TRIAGE_DISABLED', message: 'Auto-triage is disabled for this target.', retryable: false }
      });
      return;
    }
    if (settings.writeMode !== 'read_only' && !authz.can('create_read_write_runs')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'The saved auto-triage mode requires permission to create read/write runs',
          retryable: false
        }
      });
      return;
    }
    if (
      !['active', 'recovering'].includes(issue.status)
      || !issueMeetsAutoTriageThreshold(issue.severity, settings.minimumSeverity)
    ) {
      res.status(409).json({
        error: {
          code: 'AUTO_TRIAGE_ISSUE_NOT_ELIGIBLE',
          message: 'This issue is not active at the configured auto-triage severity.',
          retryable: false
        }
      });
      return;
    }
    if (!existing) {
      const started = await startSingleTargetAutoTriageIssue(issue, settings.revision);
      if (!started) {
        res.status(409).json({
          error: {
            code: 'AUTO_TRIAGE_ISSUE_NOT_ELIGIBLE',
            message: 'The issue or auto-triage settings changed before it could be queued.',
            retryable: true
          }
        });
        return;
      }
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'run',
        eventType: 'target.auto_triage_issue_started_manually.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        objectType: 'target_auto_triage_job',
        objectId: started.id,
        summary: 'Issue queued for automatic investigation',
        metadata: {
          targetId: issue.targetId,
          targetType: issue.targetType,
          issueId: issue.id,
          issueLifecycleVersion: issue.lifecycleVersion
        }
      });
      res.status(202).json(await automaticInvestigationForIssue(workspaceId, issueId));
      return;
    }
    const retried = await repo.autoTriage.retryTargetAutoTriageIssue(workspaceId, issueId);
    if (retried) {
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'run',
        eventType: 'target.auto_triage_job_queued.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        objectType: 'target_auto_triage_job',
        objectId: retried.id,
        summary: 'Automatic investigation queued for retry',
        metadata: {
          targetId: issue.targetId,
          targetType: issue.targetType,
          issueId: issue.id,
          issueLifecycleVersion: issue.lifecycleVersion,
          triggerReason: 'retry'
        }
      });
    }
    if (!retried) {
      res.status(409).json({
        error: {
          code: 'AUTO_TRIAGE_RETRY_UNAVAILABLE',
          message: 'This automatic investigation is no longer eligible for retry.',
          retryable: false
        }
      });
      return;
    }
    res.status(202).json(await automaticInvestigationForIssue(workspaceId, issueId));
  } catch (error) {
    next(error);
  }
}
