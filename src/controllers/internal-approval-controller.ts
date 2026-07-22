import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { incrementAutomationApproval } from '../metrics.js';
import { recordApprovalActivity, recordRunStatusChangedActivity } from '../services/target-chat-activity-events.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkflowExecutionEvent } from '../services/workflow-execution-events.js';
import { repo } from '../store/repository.js';
import {
  AutomationApprovalExecutionStartError,
  createAutomationRunApproval,
  deleteAutomationRunContinuation,
  expireAutomationRunApproval,
  getAutomationRunApproval,
  getAutomationRunContinuation,
  markAutomationApprovalExecutionFinished,
  startAutomationApprovalExecution,
  type AutomationApprovalSource
} from '../store/repository-automation-approvals.js';
import { ApprovalExecutionStartError } from '../store/repository-run-approvals.js';
import { gatewayTokenService } from '../services/token-service.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';

async function resolveAutomationRun(runId: string) {
  const workflowRun = await getWorkflowRun(runId);
  if (workflowRun) {
    return {
      sourceType: 'workflow' as const,
      sourceId: workflowRun.executionId,
      workspaceId: workflowRun.workspaceId,
      targetId: workflowRun.targetId,
      targetType: workflowRun.targetType,
      requestedBy: workflowRun.createdBy,
      status: workflowRun.status,
      toolOperations: workflowRun.compiledAccessScope.toolOperations,
      allowedToolRefs: [
        ...(workflowRun.compiledAccessScope.mcpTools || []),
        ...(workflowRun.compiledAccessScope.targetToolRefs || [])
      ]
    };
  }
  const agentRun = await getAgentActivityRecord(runId);
  if (agentRun) {
    return {
      sourceType: 'agent' as const,
      sourceId: agentRun.agentId,
      workspaceId: agentRun.workspaceId,
      targetId: agentRun.targetId,
      targetType: agentRun.targetType,
      requestedBy: agentRun.compiledScope.actor.userId,
      status: agentRun.status,
      toolOperations: agentRun.compiledScope.toolOperations,
      allowedToolRefs: [
        ...(agentRun.compiledScope.mcpTools || []),
        ...(agentRun.compiledScope.targetToolRefs || [])
      ]
    };
  }
  return null;
}

export async function createToolApproval(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const automationRun = await resolveAutomationRun(runId);
    if (automationRun) {
      if (automationRun.status !== 'running' && automationRun.status !== 'waiting_for_approval') {
        res.status(409).json({ error: { code: 'RUN_NOT_ACTIVE', message: 'Run is not active for an approval interrupt', retryable: false } });
        return;
      }
      if (automationRun.toolOperations[req.body.toolName] !== 'write') {
        res.status(400).json({ error: { code: 'WRITE_TOOL_NOT_GRANTED', message: 'Run is not granted this write tool', retryable: false } });
        return;
      }
      if (!automationRun.allowedToolRefs.some((ref) => (
        ref.serverId === req.body.toolRef.serverId && ref.toolName === req.body.toolRef.toolName
      ))) {
        res.status(400).json({ error: { code: 'MCP_TOOL_REF_NOT_GRANTED', message: 'Run is not granted this exact MCP tool', retryable: false } });
        return;
      }
      if (!req.body.continuation) {
        res.status(400).json({ error: { code: 'CONTINUATION_REQUIRED', message: 'A durable continuation is required before requesting approval', retryable: false } });
        return;
      }
      const approval = await createAutomationRunApproval({
        workspaceId: automationRun.workspaceId,
        sourceType: automationRun.sourceType,
        sourceId: automationRun.sourceId,
        runId,
        targetId: automationRun.targetId,
        targetType: automationRun.targetType,
        approvalKind: 'tool_write',
        toolCallId: req.body.toolCallId,
        toolName: req.body.toolName,
        toolRef: req.body.toolRef,
        summary: req.body.summary || `Approve write tool: ${req.body.toolName}`,
        arguments: req.body.arguments || {},
        requestedBy: automationRun.requestedBy,
        expiresAt: new Date(Date.now() + config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS * 1000).toISOString(),
        continuationState: req.body.continuation
      });
      if (automationRun.sourceType === 'workflow') {
        await recordWorkflowExecutionEvent({
          executionId: automationRun.sourceId,
          workspaceId: automationRun.workspaceId,
          type: 'approval_requested',
          runId,
          stepIndex: automationRun.stepIndex,
          approvalId: approval.id,
          dedupeKey: `approval-requested:${approval.id}`,
          payload: {
            approvalKind: approval.approvalKind,
            toolName: approval.toolName,
            summary: approval.summary,
            status: approval.status,
            expiresAt: approval.expiresAt
          }
        });
      }
      incrementAutomationApproval('tool_write', 'requested');
      res.status(201).json(approval);
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (run.toolAccessMode !== 'read_write') {
      res.status(400).json({ error: { code: 'READ_WRITE_REQUIRED', message: 'Run is not allowed to execute write tools', retryable: false } });
      return;
    }
    const session = await repo.getSession(run.sessionId, true);
    const resolvedTools = await resolveTargetRunTools({
      workspaceId: run.workspaceId,
      targetId: run.targetId,
      targetType: run.targetType,
      toolAccessMode: run.toolAccessMode,
      runId: run.id,
      strictMcpResolution: true
    });
    const exactTool = resolvedTools.allowedToolSpecs.find((tool) => (
      tool.name === req.body.toolName
      && tool.server_id === req.body.toolRef.serverId
      && tool.tool_name === req.body.toolRef.toolName
      && tool.capability === 'write'
    ));
    if (!exactTool) {
      res.status(400).json({ error: { code: 'MCP_TOOL_REF_NOT_GRANTED', message: 'Run is not granted this exact MCP write tool', retryable: false } });
      return;
    }
    const expiresAt = new Date(Date.now() + config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS * 1000).toISOString();
    const approval = await repo.createRunToolApproval({
      runId: run.id,
      workspaceId: run.workspaceId,
      targetId: run.targetId,
      toolCallId: req.body.toolCallId,
      toolName: req.body.toolName,
      toolRef: req.body.toolRef,
      summary: req.body.summary,
      arguments: req.body.arguments || {},
      requestedBy: session?.createdBy,
      sessionId: run.sessionId,
      expiresAt,
      continuationState: req.body.continuation
    });
    const waitingRun = await repo.getRun(run.id);
    await recordRunStatusChangedActivity(run, waitingRun);
    await recordApprovalActivity(approval, 'approval.requested', run.sessionId, run.messageId);
    webhooks.emit({
      type: 'run.tool_approval_requested.v1',
      workspaceId: run.workspaceId,
      clusterId: approval.targetType === KUBERNETES_TARGET_TYPE ? approval.targetId : undefined,
      targetId: approval.targetId,
      targetType: approval.targetType,
      subject: { type: 'tool_approval', id: approval.id },
      data: {
        runId: run.id,
        sessionId: run.sessionId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        summary: approval.summary,
        arguments: approval.arguments,
        expiresAt: approval.expiresAt
      }
    });
    res.status(201).json(approval);
  } catch (err) {
    next(err);
  }
}

export async function getRunContinuation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const automationRun = await resolveAutomationRun(runId);
    if (automationRun) {
      const continuation = await getAutomationRunContinuation(automationRun.sourceType, runId);
      if (!continuation) {
        res.status(200).json(null);
        return;
      }
      let approval = await getAutomationRunApproval(continuation.approvalId);
      if (!approval) {
        res.status(404).json({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      if (approval.status === 'pending' && new Date(approval.expiresAt).getTime() <= Date.now()) {
        approval = (await expireAutomationRunApproval(approval.id)) || approval;
      }
      res.status(200).json({ ...continuation, approval });
      return;
    }
    const continuation = await repo.getRunContinuation(runId);
    if (!continuation) {
      res.status(200).json(null);
      return;
    }
    const approval = await repo.getRunToolApproval(continuation.approvalId);
    if (!approval) {
      res.status(404).json({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found', retryable: false } });
      return;
    }
    let effectiveApproval = approval;
    if (approval.status === 'pending' && new Date(approval.expiresAt).getTime() <= Date.now()) {
      effectiveApproval = (await repo.expireRunToolApproval(approval.id)) || approval;
      if (effectiveApproval.status === 'expired') {
        const run = await repo.getRun(effectiveApproval.runId);
        if (run) {
          await recordApprovalActivity(effectiveApproval, 'approval.expired', run.sessionId, run.messageId);
        }
      }
    }
    res.status(200).json({ ...continuation, approval: effectiveApproval });
  } catch (err) {
    next(err);
  }
}

export async function markToolApprovalExecutionStarted(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const approvalId = toSingleParam(req.params.approvalId);
    const automationRun = await resolveAutomationRun(runId);
    if (automationRun) {
      const approval = await getAutomationRunApproval(approvalId);
      if (!approval || approval.runId !== runId || approval.sourceType !== automationRun.sourceType) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      const started = await startAutomationApprovalExecution(
        approval.id,
        (claims) => gatewayTokenService.signApprovalReceipt(claims)
      );
      res.status(200).json(started);
      return;
    }
    const approval = await repo.getRunToolApproval(approvalId);
    if (!approval || approval.runId !== runId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
      return;
    }
    const started = await repo.startRunToolApprovalExecution(
      approval.id,
      (claims) => gatewayTokenService.signApprovalReceipt(claims)
    );
    res.status(200).json(started);
  } catch (err) {
    if (err instanceof ApprovalExecutionStartError || err instanceof AutomationApprovalExecutionStartError) {
      res.status(409).json({
        error: { code: err.code, message: err.code === 'APPROVAL_NOT_GRANTED'
          ? 'Write approval was not granted'
          : 'Approval execution has already started', retryable: false },
        approval: err.approval
      });
      return;
    }
    next(err);
  }
}

export async function markToolApprovalExecutionFinished(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const approvalId = toSingleParam(req.params.approvalId);
    const automationRun = await resolveAutomationRun(runId);
    if (automationRun) {
      const approval = await getAutomationRunApproval(approvalId);
      if (!approval || approval.runId !== runId || approval.sourceType !== automationRun.sourceType) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      res.status(200).json(await markAutomationApprovalExecutionFinished(
        approval.id,
        req.body.result,
        Boolean(req.body.isError)
      ));
      return;
    }
    const approval = await repo.getRunToolApproval(approvalId);
    if (!approval || approval.runId !== runId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
      return;
    }
    const updated = await repo.markRunToolApprovalExecutionFinished(
      approval.id,
      req.body.result,
      Boolean(req.body.isError)
    );
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

export async function consumeRunContinuation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const automationRun = await resolveAutomationRun(runId);
    if (automationRun) {
      await deleteAutomationRunContinuation(automationRun.sourceType as AutomationApprovalSource, runId);
      res.status(204).send();
      return;
    }
    await repo.deleteRunContinuation(runId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
