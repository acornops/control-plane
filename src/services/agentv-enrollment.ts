import { parseVirtualMachinePlatform } from '../types/virtual-machine-platform.js';
import { buildVirtualMachineWindowsInstallInstructions } from './virtual-machine-windows-install-instructions.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { repo } from '../store/repository.js';
import type { AgentVEnrollmentPurpose } from '../types/agentv-enrollment.js';
import { hashSecret } from '../utils/crypto.js';
import { buildVirtualMachineInstallInstructions } from './virtual-machine-install-instructions.js';
import { config } from '../config.js';
import type { AgentVAccessPolicy } from '../types/agentv-access-policy.js';

const AGENTV_ENROLLMENT_TTL_MS = 15 * 60 * 1000;

export async function issueAgentVEnrollment(input: {
  targetId: string; workspaceId: string; purpose: AgentVEnrollmentPurpose; createdBy: string;
  accessPolicy: AgentVAccessPolicy;
  markAccessPolicyUpdate?: boolean;
}) {
  const vm = await repo.getVirtualMachine(input.targetId);
  const windows = vm?.osFamily === 'windows';
  if (windows && (input.accessPolicy.accessMode !== 'read_only' || input.accessPolicy.restartServices.length)) throw new Error('Windows AgentV supports read-only access');
  const release = agentVInstallRelease(windows);
  const id = randomUUID();
  const token = `aev_${id}_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + AGENTV_ENROLLMENT_TTL_MS).toISOString();
  const created = await repo.agentv.createAgentVEnrollment({
    id, targetId: input.targetId, workspaceId: input.workspaceId, purpose: input.purpose,
    accessPolicy: input.accessPolicy, tokenHash: hashSecret(token), createdBy: input.createdBy, expiresAt,
    markAccessPolicyUpdate: input.markAccessPolicyUpdate
  });
  if (!created) return null;
  return {
    enrollmentId: id,
    expiresAt,
    installInstructions: (windows ? buildVirtualMachineWindowsInstallInstructions : buildVirtualMachineInstallInstructions)({
      platformUrl: config.CONTROL_PLANE_BASE_URL,
      targetId: input.targetId,
      enrollmentToken: token,
      enrollmentExpiresAt: expiresAt,
      replaceCredential: input.purpose === 'replace',
      policyUpdate: input.markAccessPolicyUpdate,
      ...release
    })
  };
}

function agentVInstallRelease(windows: boolean) {
  if (!windows) return { releaseVersion: config.AGENTV_SYSTEMD_RELEASE_VERSION, releaseBaseUrl: config.AGENTV_SYSTEMD_RELEASE_BASE_URL };
  if (!config.AGENTV_WINDOWS_ENABLED || !config.AGENTV_WINDOWS_RELEASE_VERSION || !config.AGENTV_WINDOWS_RELEASE_BASE_URL) throw new Error('Windows AgentV rollout is disabled or unqualified');
  return { releaseVersion: config.AGENTV_WINDOWS_RELEASE_VERSION, releaseBaseUrl: config.AGENTV_WINDOWS_RELEASE_BASE_URL };
}

export function buildAgentVRepairInstructions(targetId: string, osFamily: 'linux' | 'windows' = 'linux') {
  const windows = osFamily === 'windows';
  return (windows ? buildVirtualMachineWindowsInstallInstructions : buildVirtualMachineInstallInstructions)({
    platformUrl: config.CONTROL_PLANE_BASE_URL,
    targetId,
    ...agentVInstallRelease(windows)
  });
}

export function buildAgentVTargetRepairInstructions(targetId: string, metadata: Record<string, unknown>) {
  const platform = parseVirtualMachinePlatform(metadata);
  if (!platform) throw new Error('Stored VM platform is invalid');
  return buildAgentVRepairInstructions(targetId, platform.osFamily);
}

export function parseAgentVEnrollmentToken(token: string): string | null {
  const match = /^aev_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/i.exec(token);
  return match?.[1] || null;
}
