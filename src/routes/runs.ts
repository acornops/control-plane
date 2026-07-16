import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as runsController from '../controllers/runs-controller.js';
import * as toolResultArtifactController from '../controllers/tool-result-artifact-controller.js';
import { toolApprovalDecisionSchema } from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const runsRouter = Router();
const authed = authenticatedHandler;
runsRouter.get('/runs/:runId', requireActor(['user', 'externalIntegration']), authed(runsController.getRun));
runsRouter.get('/runs/:runId/events', requireActor(['user', 'externalIntegration']), authed(runsController.listRunEvents));
runsRouter.get('/runs/:runId/tool-result-artifacts/:artifactId', requireActor(['user']), authed(toolResultArtifactController.getToolResultArtifact));
runsRouter.get('/runs/:runId/approvals', requireActor(['user', 'externalIntegration']), authed(runsController.listRunApprovals));
runsRouter.post(
  '/runs/:runId/approvals/:approvalId/decision',
  requireActor(['user']),
  validateBody(toolApprovalDecisionSchema),
  authed(runsController.decideRunApproval)
);
runsRouter.post('/runs/:runId/cancel', requireActor(['user']), authed(runsController.cancelRun));
runsRouter.get('/runs/:runId/stream', requireActor(['user', 'externalIntegration']), authed(runsController.streamRun));
