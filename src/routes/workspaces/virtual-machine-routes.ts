import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import { registerVirtualMachineSchema, updateVirtualMachineSchema } from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerVirtualMachineRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/virtual-machines', requireUser, authed(workspacesController.listVirtualMachines));
  router.post(
    '/workspaces/:workspaceId/virtual-machines',
    requireUser,
    validateBody(registerVirtualMachineSchema),
    authed(workspacesController.registerVirtualMachine)
  );
  router.get('/workspaces/:workspaceId/virtual-machines/:vmId', requireUser, authed(workspacesController.getVirtualMachine));
  router.patch(
    '/workspaces/:workspaceId/virtual-machines/:vmId',
    requireUser,
    validateBody(updateVirtualMachineSchema),
    authed(workspacesController.updateVirtualMachine)
  );
  router.delete('/workspaces/:workspaceId/virtual-machines/:vmId', requireUser, authed(workspacesController.deleteVirtualMachine));
  router.post('/workspaces/:workspaceId/virtual-machines/:vmId/rotate-agent-key', requireUser, authed(workspacesController.rotateVirtualMachineAgentKey));
  router.get('/workspaces/:workspaceId/virtual-machines/:vmId/resources', requireUser, authed(workspacesController.listVirtualMachineInventory));
  router.get('/workspaces/:workspaceId/virtual-machines/:vmId/findings', requireUser, authed(workspacesController.listVirtualMachineFindings));
  router.get('/workspaces/:workspaceId/virtual-machines/:vmId/metrics/history', requireUser, authed(workspacesController.getVirtualMachineMetricsHistory));
  router.get('/workspaces/:workspaceId/virtual-machines/:vmId/logs', requireUser, authed(workspacesController.getVirtualMachineLogs));
}
