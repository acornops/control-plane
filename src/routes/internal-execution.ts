import { Router } from 'express';
import { requireGatewayRunToken, requireServiceToken } from '../auth/middleware.js';
import * as internalApprovalController from '../controllers/internal-approval-controller.js';
import * as internalExecutionController from '../controllers/internal-execution-controller.js';
import * as internalMcpBridgeController from '../controllers/internal-mcp-bridge-controller.js';
import * as internalToolingController from '../controllers/internal-tooling-controller.js';
import {
  createToolApprovalSchema,
  internalMcpToolCallSchema,
  internalToolingSyncSchema,
  toolApprovalExecutionFinishedSchema,
  runCommitSchema,
  runEventsBatchSchema
} from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const internalExecutionRouter = Router();

internalExecutionRouter.post('/runs/:runId/bootstrap', requireServiceToken, internalExecutionController.bootstrap);
internalExecutionRouter.get('/runs/:runId/skills/:skillRef', requireServiceToken, internalExecutionController.getRunSkillSnapshot);
internalExecutionRouter.post(
  '/runs/:runId/approvals',
  requireServiceToken,
  validateBody(createToolApprovalSchema),
  internalApprovalController.createToolApproval
);
internalExecutionRouter.get(
  '/runs/:runId/continuation',
  requireServiceToken,
  internalApprovalController.getRunContinuation
);
internalExecutionRouter.post(
  '/runs/:runId/approvals/:approvalId/execution-started',
  requireServiceToken,
  internalApprovalController.markToolApprovalExecutionStarted
);
internalExecutionRouter.post(
  '/runs/:runId/approvals/:approvalId/execution-finished',
  requireServiceToken,
  validateBody(toolApprovalExecutionFinishedSchema),
  internalApprovalController.markToolApprovalExecutionFinished
);
internalExecutionRouter.delete(
  '/runs/:runId/continuation',
  requireServiceToken,
  internalApprovalController.consumeRunContinuation
);
internalExecutionRouter.get('/sessions/:sessionId/context', requireServiceToken, internalExecutionController.getSessionContext);
internalExecutionRouter.get('/workflow-sessions/:sessionId/context', requireServiceToken, internalExecutionController.getWorkflowSessionContext);
internalExecutionRouter.post(
  '/runs/:runId/events',
  requireServiceToken,
  validateBody(runEventsBatchSchema),
  internalExecutionController.ingestRunEvents
);
internalExecutionRouter.get(
  '/runs/:runId/event-cursor',
  requireServiceToken,
  internalExecutionController.getRunEventCursor
);
internalExecutionRouter.post(
  '/runs/:runId/commit',
  requireServiceToken,
  validateBody(runCommitSchema),
  internalExecutionController.commitRun
);
internalExecutionRouter.get('/runs/:runId/commit', requireServiceToken, internalExecutionController.getRunCommit);
internalExecutionRouter.post(
  '/mcp/tools/call',
  requireGatewayRunToken,
  validateBody(internalMcpToolCallSchema),
  internalMcpBridgeController.callMcpTool
);
internalExecutionRouter.post(
  '/tooling/sync',
  requireServiceToken,
  validateBody(internalToolingSyncSchema),
  internalToolingController.syncTooling
);
