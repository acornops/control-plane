import { Router } from 'express';
import {
  commitAgentVInstallation,
  exchangeAgentVEnrollment,
  getAgentVInstallationStatus,
  rollbackAgentVInstallation
} from '../controllers/agentv-installation-controller.js';

export const agentVInstallationsRouter = Router();

agentVInstallationsRouter.post(
  '/agentv/enrollments/exchange',
  exchangeAgentVEnrollment
);
agentVInstallationsRouter.get('/agentv/installations/:transactionId/status', getAgentVInstallationStatus);
agentVInstallationsRouter.post('/agentv/installations/:transactionId/commit', commitAgentVInstallation);
agentVInstallationsRouter.post('/agentv/installations/:transactionId/rollback', rollbackAgentVInstallation);
