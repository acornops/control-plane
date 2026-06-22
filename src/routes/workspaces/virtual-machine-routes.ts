import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import { registerVirtualMachineSchema, updateVirtualMachineSchema } from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerVirtualMachineRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/virtual-machines', requireActor(['user', 'externalIntegration']), authed(workspacesController.listVirtualMachines));
  router.post(
    '/workspaces/:workspaceId/virtual-machines',
    requireActor(['user']),
    validateBody(registerVirtualMachineSchema),
    authed(workspacesController.registerVirtualMachine)
  );
  router.get('/workspaces/:workspaceId/virtual-machines/:vmId', requireActor(['user', 'externalIntegration']), authed(workspacesController.getVirtualMachine));
  router.patch(
    '/workspaces/:workspaceId/virtual-machines/:vmId',
    requireActor(['user']),
    validateBody(updateVirtualMachineSchema),
    authed(workspacesController.updateVirtualMachine)
  );
  router.delete('/workspaces/:workspaceId/virtual-machines/:vmId', requireActor(['user']), authed(workspacesController.deleteVirtualMachine));
  router.post(
    '/workspaces/:workspaceId/virtual-machines/:vmId/rotate-agent-key',
    requireActor(['user']),
    authed(workspacesController.rotateVirtualMachineAgentKey)
  );
  router.get(
    '/workspaces/:workspaceId/virtual-machines/:vmId/resources',
    requireActor(['user', 'externalIntegration']),
    authed(workspacesController.listVirtualMachineInventory)
  );
  router.get(
    '/workspaces/:workspaceId/virtual-machines/:vmId/findings',
    requireActor(['user', 'externalIntegration']),
    authed(workspacesController.listVirtualMachineFindings)
  );
  router.get(
    '/workspaces/:workspaceId/virtual-machines/:vmId/metrics/history',
    requireActor(['user']),
    authed(workspacesController.getVirtualMachineMetricsHistory)
  );
  router.get('/workspaces/:workspaceId/virtual-machines/:vmId/logs', requireActor(['user']), authed(workspacesController.getVirtualMachineLogs));
}
