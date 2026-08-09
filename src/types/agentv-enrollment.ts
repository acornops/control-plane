import type { AgentVAccessPolicy } from './agentv-access-policy.js';

export type AgentVEnrollmentPurpose = 'initial' | 'replace';
type AgentVEnrollmentStatus = 'issued' | 'exchanged' | 'verified' | 'completed' | 'cancelled' | 'expired';
type AgentVCredentialState = 'pending' | 'active' | 'grace' | 'revoked';

export interface AgentVEnrollment {
  id: string;
  targetId: string;
  workspaceId: string;
  purpose: AgentVEnrollmentPurpose;
  accessPolicy: AgentVAccessPolicy;
  tokenHash: string;
  transactionSecretHash?: string;
  status: AgentVEnrollmentStatus;
  expiresAt: string;
  transactionExpiresAt?: string;
}

export interface AgentVCredential {
  id: string;
  targetId: string;
  enrollmentId: string;
  keyHash: string;
  generation: number;
  state: AgentVCredentialState;
}
