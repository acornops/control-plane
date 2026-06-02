import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import { registerClusterSchema, updateClusterSchema } from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerKubernetesClusterRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/kubernetes-clusters', requireUser, authed(workspacesController.listClusters));
  router.post(
    '/workspaces/:workspaceId/kubernetes-clusters',
    requireUser,
    validateBody(registerClusterSchema),
    authed(workspacesController.registerCluster)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/metrics/history',
    requireUser,
    authed(workspacesController.getWorkspaceClusterMetricsHistory)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/tools/catalog',
    requireUser,
    authed(workspacesController.listKubernetesClusterToolsCatalog)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/resources',
    requireUser,
    authed(workspacesController.listClusterResources)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/findings',
    requireUser,
    authed(workspacesController.listClusterFindings)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/metrics/history',
    requireUser,
    authed(workspacesController.getClusterMetricsHistory)
  );
  router.get(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/pods/:namespace/:podName/logs',
    requireUser,
    authed(workspacesController.getPodLogs)
  );
  router.post(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/rotate-agent-key',
    requireUser,
    authed(workspacesController.rotateAgentKey)
  );
  router.get('/workspaces/:workspaceId/kubernetes-clusters/:clusterId', requireUser, authed(workspacesController.getCluster));
  router.patch(
    '/workspaces/:workspaceId/kubernetes-clusters/:clusterId',
    requireUser,
    validateBody(updateClusterSchema),
    authed(workspacesController.updateCluster)
  );
  router.delete('/workspaces/:workspaceId/kubernetes-clusters/:clusterId', requireUser, authed(workspacesController.deleteCluster));
}
