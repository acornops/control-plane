import { randomBytes, randomUUID } from 'node:crypto';
import { repo } from '../store/repository.js';
import type { AgentVEnrollmentPurpose } from '../types/agentv-enrollment.js';
import { hashSecret } from '../utils/crypto.js';
import { buildVirtualMachineInstallInstructions } from './virtual-machine-install-instructions.js';
import { config } from '../config.js';

export const AGENTV_ENROLLMENT_TTL_MS = 15 * 60 * 1000;

export async function issueAgentVEnrollment(input: {
  targetId: string; workspaceId: string; purpose: AgentVEnrollmentPurpose; createdBy: string;
}) {
  const id = randomUUID();
  const token = `aev_${id}_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + AGENTV_ENROLLMENT_TTL_MS).toISOString();
  const created = await repo.agentv.createAgentVEnrollment({
    id, targetId: input.targetId, workspaceId: input.workspaceId, purpose: input.purpose,
    tokenHash: hashSecret(token), createdBy: input.createdBy, expiresAt
  });
  if (!created) return null;
  return {
    expiresAt,
    installInstructions: buildVirtualMachineInstallInstructions({
      platformUrl: config.CONTROL_PLANE_BASE_URL,
      targetId: input.targetId,
      enrollmentToken: token,
      enrollmentExpiresAt: expiresAt,
      replaceCredential: input.purpose === 'replace',
      releaseVersion: config.AGENTV_SYSTEMD_RELEASE_VERSION,
      releaseBaseUrl: config.AGENTV_SYSTEMD_RELEASE_BASE_URL
    })
  };
}

export function buildAgentVRepairInstructions(targetId: string) {
  return buildVirtualMachineInstallInstructions({
    platformUrl: config.CONTROL_PLANE_BASE_URL,
    targetId,
    releaseVersion: config.AGENTV_SYSTEMD_RELEASE_VERSION,
    releaseBaseUrl: config.AGENTV_SYSTEMD_RELEASE_BASE_URL
  });
}

export function parseAgentVEnrollmentToken(token: string): string | null {
  const match = /^aev_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/i.exec(token);
  return match?.[1] || null;
}
