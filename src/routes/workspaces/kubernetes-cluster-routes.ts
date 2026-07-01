import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import { registerClusterSchema, updateClusterSchema } from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerKubernetesClusterRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/kubernetes-clusters', requireActor(['user', 'externalIntegration']), authed(workspacesController.listClusters));
  router.post(
    '/workspaces/:workspaceId/kubernetes-clusters',
    requireActor(['user']),
    validateBody(registerClusterSchema),
    authed(workspacesController.registerCluster)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/metrics/history',
    requireActor(['user']),
    authed(workspacesController.getWorkspaceClusterMetricsHistory)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/resources',
    requireActor(['user', 'externalIntegration']),
    authed(workspacesController.listClusterResources)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/metrics/history',
    requireActor(['user']),
    authed(workspacesController.getClusterMetricsHistory)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/pods/:namespace/:podName/logs',
    requireActor(['user']),
    authed(workspacesController.getPodLogs)
  );
  router.post(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/rotate-agent-key',
    requireActor(['user']),
    authed(workspacesController.rotateAgentKey)
  );
  router.get('/workspaces/:workspaceId/kubernetes-clusters/:clusterId', requireActor(['user', 'externalIntegration']), authed(workspacesController.getCluster));
  router.patch(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId',
    requireActor(['user']),
    validateBody(updateClusterSchema),
    authed(workspacesController.updateCluster)
  );
  router.delete('/workspaces/:workspaceId/kubernetes-clusters/:clusterId', requireActor(['user']), authed(workspacesController.deleteCluster));
}
