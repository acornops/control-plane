import { Router } from 'express';
import { registerKubernetesClusterRoutes } from './workspaces/kubernetes-cluster-routes.js';
import { registerTargetRoutes } from './workspaces/target-routes.js';
import { registerVirtualMachineRoutes } from './workspaces/virtual-machine-routes.js';
import { registerWorkspaceRoutes } from './workspaces/workspace-routes.js';

export const workspacesRouter = Router();

registerWorkspaceRoutes(workspacesRouter);
registerTargetRoutes(workspacesRouter);
registerKubernetesClusterRoutes(workspacesRouter);
registerVirtualMachineRoutes(workspacesRouter);
