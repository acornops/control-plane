import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../auth/middleware.js';
import * as runsController from '../controllers/runs-controller.js';
import { toolApprovalDecisionSchema } from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const runsRouter = Router();
const authed = authenticatedHandler;
runsRouter.get('/runs/:runId', requireUser, authed(runsController.getRun));
runsRouter.get('/runs/:runId/events', requireUser, authed(runsController.listRunEvents));
runsRouter.get('/runs/:runId/approvals', requireUser, authed(runsController.listRunApprovals));
runsRouter.post(
  '/runs/:runId/approvals/:approvalId/decision',
  requireUser,
  validateBody(toolApprovalDecisionSchema),
  authed(runsController.decideRunApproval)
);
runsRouter.post('/runs/:runId/cancel', requireUser, authed(runsController.cancelRun));
runsRouter.get('/runs/:runId/stream', requireUser, authed(runsController.streamRun));
