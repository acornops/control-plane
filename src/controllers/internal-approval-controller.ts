import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { incrementAutomationApproval } from '../metrics.js';
import { recordApprovalActivity, recordRunStatusChangedActivity } from '../services/target-chat-activity-events.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkflowExecutionEvent } from '../services/workflow-execution-events.js';
import { repo } from '../store/repository.js';
import {
  AutomationApprovalConflictError,
  AutomationApprovalExecutionStartError,
  createAutomationRunApproval,
  deleteAutomationRunContinuation,
  expireAutomationRunApproval,
  getAutomationRunApproval,
  getAutomationRunContinuation,
  markAutomationApprovalExecutionFinished,
  startAutomationApprovalExecution
} from '../store/repository-automation-approvals.js';
import { ApprovalExecutionStartError } from '../store/repository-run-approvals.js';
import { gatewayTokenService } from '../services/token-service.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { resolveAgentChatRunTools } from '../services/agent-chat-run-tools.js';
import { TARGETS_MCP_SERVER_ID } from '../services/targets-mcp.js';
import type { TargetType } from '../types/domain.js';

type TargetsMcpSelection =
  | { kind: 'not_applicable' }
  | { kind: 'invalid' }
  | { kind: 'valid'; targetId: string; targetType: TargetType };

export async function resolveTargetsMcpSelection(input: {
  workspaceId: string;
  serverId: string;
  arguments: Record<string, unknown> | undefined;
}): Promise<TargetsMcpSelection> {
  if (input.serverId !== TARGETS_MCP_SERVER_ID) return { kind: 'not_applicable' };
  const targetId = typeof input.arguments?.target_id === 'string'
    ? input.arguments.target_id
    : '';
  const targetType = input.arguments?.target_type === 'kubernetes'
    || input.arguments?.target_type === 'virtual_machine'
    ? input.arguments.target_type
    : undefined;
  if (!targetId || !targetType) return { kind: 'invalid' };
  const target = await repo.getTarget(input.workspaceId, targetId);
  return target?.targetType === targetType
    ? { kind: 'valid', targetId, targetType }
    : { kind: 'invalid' };
}

async function resolveAutomationRun(runId: string) {
  const workflowRun = await getWorkflowRun(runId);
  if (workflowRun) {
    return {
      executionId: workflowRun.executionId,
      workspaceId: workflowRun.workspaceId,
      requestedBy: workflowRun.createdBy,
      status: workflowRun.status,
      toolOperations: workflowRun.compiledAccessScope.toolOperations,
      allowedToolRefs: workflowRun.compiledAccessScope.mcpTools || []
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
      const targetSelection = await resolveTargetsMcpSelection({
        workspaceId: automationRun.workspaceId,
        serverId: req.body.toolRef.serverId,
        arguments: req.body.arguments
      });
      if (targetSelection.kind === 'invalid') {
        res.status(400).json({ error: { code: 'MCP_TARGET_INVALID', message: 'The target MCP call requires a valid workspace target.', retryable: false } });
        return;
      }
      if (!req.body.continuation) {
        res.status(400).json({ error: { code: 'CONTINUATION_REQUIRED', message: 'A durable continuation is required before requesting approval', retryable: false } });
        return;
      }
      const approval = await createAutomationRunApproval({
        workspaceId: automationRun.workspaceId,
        runId,
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
      await recordWorkflowExecutionEvent({
        executionId: automationRun.executionId,
        workspaceId: automationRun.workspaceId,
        type: 'approval_requested',
        runId,
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
    if (run.status !== 'running' && run.status !== 'waiting_for_approval') {
      res.status(409).json({ error: { code: 'RUN_NOT_ACTIVE', message: 'Run is not active for an approval interrupt', retryable: false } });
      return;
    }
    const session = await repo.getSession(run.sessionId, true);
    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found for run', retryable: false } });
      return;
    }
    const resolvedTools = run.conversationKind === 'agent_chat'
      ? await resolveAgentChatRunTools(run)
      : run.targetId && run.targetType
        ? await resolveTargetRunTools({
            workspaceId: run.workspaceId,
            targetId: run.targetId,
            targetType: run.targetType,
            toolAccessMode: run.toolAccessMode,
            runId: run.id,
            strictMcpResolution: true
          })
        : null;
    if (!resolvedTools) {
      res.status(409).json({ error: { code: 'RUN_SCOPE_INVALID', message: 'Interactive run scope is incomplete', retryable: false } });
      return;
    }
    const exactTool = resolvedTools.allowedToolSpecs.find((tool) => {
      if (tool.name !== req.body.toolName || tool.capability !== 'write') return false;
      return tool.server_id === req.body.toolRef.serverId && tool.tool_name === req.body.toolRef.toolName;
    });
    if (!exactTool) {
      res.status(400).json({ error: { code: 'MCP_TOOL_REF_NOT_GRANTED', message: 'Run is not granted this exact MCP write tool', retryable: false } });
      return;
    }
    const targetSelection = await resolveTargetsMcpSelection({
      workspaceId: run.workspaceId,
      serverId: req.body.toolRef.serverId,
      arguments: req.body.arguments
    });
    if (targetSelection.kind === 'invalid') {
      res.status(400).json({ error: { code: 'MCP_TARGET_INVALID', message: 'The target MCP call requires a valid workspace target.', retryable: false } });
      return;
    }
    const expiresAt = new Date(Date.now() + config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS * 1000).toISOString();
    const approval = await repo.createRunToolApproval({
      runId: run.id,
      workspaceId: run.workspaceId,
      targetId: run.targetId || (targetSelection.kind === 'valid' ? targetSelection.targetId : undefined),
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
    if (approval.targetId && approval.targetType) {
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
    }
    res.status(201).json(approval);
  } catch (err) {
    if (err instanceof AutomationApprovalConflictError) {
      res.status(409).json({
        error: {
          code: err.code,
          message: err.message,
          retryable: false
        }
      });
      return;
    }
    next(err);
  }
}

export async function getRunContinuation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const automationRun = await resolveAutomationRun(runId);
    if (automationRun) {
      const continuation = await getAutomationRunContinuation(runId);
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
      if (!approval || approval.runId !== runId) {
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
      if (!approval || approval.runId !== runId) {
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
      await deleteAutomationRunContinuation(runId);
      res.status(204).send();
      return;
    }
    await repo.deleteRunContinuation(runId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
