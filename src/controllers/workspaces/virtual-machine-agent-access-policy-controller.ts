import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import { issueAgentVEnrollment } from '../../services/agentv-enrollment.js';
import { webhooks } from '../../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { repo } from '../../store/repository.js';
import { agentVAccessPoliciesEqual } from '../../types/agentv-access-policy.js';
import { VIRTUAL_MACHINE_TARGET_TYPE } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';

export async function createVirtualMachineAgentAccessPolicyUpdate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const vmId = toSingleParam(req.params.vmId);
    const access = await requireTargetAccess(req, res, workspaceId, vmId);
    if (!access) return;
    if (access.target.targetType !== VIRTUAL_MACHINE_TARGET_TYPE) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Virtual machine not found', retryable: false } });
      return;
    }
    if (!access.authz.can('manage_targets')) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Target management capability is required to change AgentV host access', retryable: false }
      });
      return;
    }
    if (!(await repo.getTargetAgentRegistration(vmId))) {
      res.status(409).json({
        error: {
          code: 'AGENTV_CREDENTIAL_NOT_ACTIVE',
          message: 'Finish initial AgentV enrollment before changing its host access policy',
          retryable: false
        }
      });
      return;
    }
    const vm = await repo.getVirtualMachine(vmId);
    if (!vm) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Virtual machine not found', retryable: false } });
      return;
    }
    const requestedPolicy = {
      accessMode: req.body.agentAccessMode as 'read_only' | 'read_write',
      restartServices: req.body.restartServices as string[]
    };
    if (agentVAccessPoliciesEqual(
      { accessMode: vm.agentAccessMode, restartServices: vm.restartServices },
      requestedPolicy
    )) {
      res.status(409).json({
        error: { code: 'AGENTV_ACCESS_POLICY_ALREADY_APPLIED', message: 'This AgentV host access policy is already applied', retryable: false }
      });
      return;
    }
    const enrollment = await issueAgentVEnrollment({
      targetId: vmId,
      workspaceId,
      purpose: 'replace',
      createdBy: req.auth.userId,
      accessPolicy: requestedPolicy,
      markAccessPolicyUpdate: true
    });
    if (!enrollment) {
      res.status(409).json({
        error: {
          code: 'AGENTV_ACCESS_POLICY_UPDATE_CONFLICT',
          message: 'AgentV credential state changed while generating the host policy command; refresh and try again',
          retryable: true
        }
      });
      return;
    }
    const updatedVm = await repo.getVirtualMachine(vmId);
    if (!updatedVm) throw new Error('AgentV host policy update lost its virtual machine target');
    webhooks.emit({
      type: 'target.updated.v1',
      workspaceId,
      targetId: vmId,
      targetType: VIRTUAL_MACHINE_TARGET_TYPE,
      subject: { type: 'target', id: vmId },
      data: {
        targetType: VIRTUAL_MACHINE_TARGET_TYPE,
        name: updatedVm.name,
        status: updatedVm.status,
        agentAccessPolicyState: 'pending_host_update',
        updatedAt: updatedVm.updatedAt
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'target',
      eventType: 'agent.host_access_policy_update_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'virtual_machine',
      objectId: vmId,
      objectName: vm.name,
      summary: 'AgentV host access policy update created',
      metadata: {
        previousAccessMode: vm.agentAccessMode,
        previousRestartServiceCount: vm.restartServices.length,
        requestedAccessMode: requestedPolicy.accessMode,
        requestedRestartServiceCount: requestedPolicy.restartServices.length,
        expiresAt: enrollment.expiresAt
      }
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ virtualMachine: updatedVm, installInstructions: enrollment.installInstructions });
  } catch (err) {
    next(err);
  }
}
