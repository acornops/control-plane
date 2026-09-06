import { z } from 'zod';
import { saveDependencyWait } from '../controllers/internal-dependency-wait-controller.js';
import { registerRunCapacityRoutes } from '../controllers/internal-run-capacity-controller.js';
import { requireExecutionAccess } from '../services/workspace-execution-access.js';
import { Router } from 'express';
import { requireGatewayRunToken, requireServiceToken } from '../auth/middleware.js';
import * as internalApprovalController from '../controllers/internal-approval-controller.js';
import * as internalExecutionController from '../controllers/internal-execution-controller.js';
import * as internalDelegationController from '../controllers/internal-delegation-controller.js';
import * as internalMcpBridgeController from '../controllers/internal-mcp-bridge-controller.js';
import * as internalPlatformNativeToolController from '../controllers/internal-platform-native-tool-controller.js';
import * as internalToolingController from '../controllers/internal-tooling-controller.js';
import * as toolResultArtifactController from '../controllers/tool-result-artifact-controller.js';
import {
  createToolApprovalSchema,
  internalMcpToolCallSchema,
  platformNativeToolCallSchema,
  internalToolingSyncSchema,
  toolApprovalExecutionFinishedSchema,
  runCommitSchema,
  runEventsBatchSchema,
  toolResultArtifactCreateSchema
} from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const internalExecutionRouter = Router();
registerRunCapacityRoutes(internalExecutionRouter);
internalExecutionRouter.post('/runs/:runId/dependency-wait', requireServiceToken, requireExecutionAccess,
  validateBody(z.object({ generation: z.number().int().nonnegative(), state: z.record(z.unknown()) }).strict()), saveDependencyWait);

internalExecutionRouter.post('/runs/:runId/bootstrap', requireServiceToken, requireExecutionAccess, internalExecutionController.bootstrap);
internalExecutionRouter.post(
  '/runs/:runId/native-tools/:toolId/call',
  requireServiceToken, requireExecutionAccess,
  validateBody(platformNativeToolCallSchema),
  internalPlatformNativeToolController.callPlatformNativeTool
);
internalExecutionRouter.post('/runs/:runId/delegations', requireServiceToken, requireExecutionAccess, internalDelegationController.delegateSpecialist);
internalExecutionRouter.get('/runs/:runId/delegations', requireServiceToken, requireExecutionAccess, internalDelegationController.awaitDelegations);
internalExecutionRouter.get('/runs/:runId/skills/:skillRef', requireServiceToken, requireExecutionAccess, internalExecutionController.getRunSkillSnapshot);
internalExecutionRouter.get('/runs/:runId/context', requireServiceToken, requireExecutionAccess, internalExecutionController.getWorkflowRunContext);
internalExecutionRouter.post(
  '/runs/:runId/approvals',
  requireServiceToken, requireExecutionAccess,
  validateBody(createToolApprovalSchema),
  internalApprovalController.createToolApproval
);
internalExecutionRouter.get(
  '/runs/:runId/continuation',
  requireServiceToken, requireExecutionAccess,
  internalApprovalController.getRunContinuation
);
internalExecutionRouter.post(
  '/runs/:runId/approvals/:approvalId/execution-started',
  requireServiceToken, requireExecutionAccess,
  internalApprovalController.markToolApprovalExecutionStarted
);
internalExecutionRouter.post(
  '/runs/:runId/approvals/:approvalId/execution-finished',
  requireServiceToken, requireExecutionAccess,
  validateBody(toolApprovalExecutionFinishedSchema),
  internalApprovalController.markToolApprovalExecutionFinished
);
internalExecutionRouter.delete(
  '/runs/:runId/continuation',
  requireServiceToken, requireExecutionAccess,
  internalApprovalController.consumeRunContinuation
);
internalExecutionRouter.get('/sessions/:sessionId/context', requireServiceToken, requireExecutionAccess, internalExecutionController.getSessionContext);
internalExecutionRouter.post(
  '/runs/:runId/events',
  requireServiceToken, requireExecutionAccess,
  validateBody(runEventsBatchSchema),
  internalExecutionController.ingestRunEvents
);
internalExecutionRouter.post(
  '/runs/:runId/tool-result-artifacts',
  requireServiceToken, requireExecutionAccess,
  validateBody(toolResultArtifactCreateSchema),
  toolResultArtifactController.createToolResultArtifact
);
internalExecutionRouter.get(
  '/runs/:runId/event-cursor',
  requireServiceToken, requireExecutionAccess,
  internalExecutionController.getRunEventCursor
);
internalExecutionRouter.post(
  '/runs/:runId/commit',
  requireServiceToken, requireExecutionAccess,
  validateBody(runCommitSchema),
  internalExecutionController.commitRun
);
internalExecutionRouter.get('/runs/:runId/commit', requireServiceToken, requireExecutionAccess, internalExecutionController.getRunCommit);
internalExecutionRouter.post(
  '/mcp/tools/call',
  requireGatewayRunToken, requireExecutionAccess,
  validateBody(internalMcpToolCallSchema),
  internalMcpBridgeController.callMcpTool
);
internalExecutionRouter.post(
  '/tooling/sync',
  requireServiceToken, requireExecutionAccess,
  validateBody(internalToolingSyncSchema),
  internalToolingController.syncTooling
);
