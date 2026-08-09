import { JsonSchema, schemaRef, stringArray, uuid } from './schema-types.js';

export function buildVirtualMachineInstallSchemas(): Record<string, JsonSchema> {
  return {
    VirtualMachineInstallInstructions: {
      type: 'object',
      required: ['command', 'releaseVersion', 'bootstrapUrl', 'warnings'],
      properties: {
        command: { type: 'string', description: 'Executable shell only; initial/replacement commands contain a short-lived enrollment token.' },
        releaseVersion: { type: 'string', description: 'Exact immutable AgentV semantic version.' },
        bootstrapUrl: { type: 'string', format: 'uri' },
        enrollmentExpiresAt: { type: 'string', format: 'date-time' },
        warnings: stringArray
      },
      additionalProperties: false
    },
    VirtualMachineAgentEnrollment: {
      type: 'object',
      required: ['targetId', 'installInstructions'],
      properties: {
        targetId: uuid,
        installInstructions: schemaRef('VirtualMachineInstallInstructions')
      },
      additionalProperties: false
    },
    AgentVEnrollmentExchange: {
      type: 'object',
      required: ['transactionId', 'transactionSecret', 'agentKey', 'purpose'],
      properties: {
        transactionId: uuid,
        transactionSecret: { type: 'string', writeOnly: true },
        agentKey: { type: 'string', writeOnly: true },
        purpose: { type: 'string', enum: ['initial', 'replace'] }
      },
      additionalProperties: false
    },
    AgentVInstallationStatus: {
      type: 'object',
      required: ['transactionId', 'status', 'credentialState', 'activeConnected'],
      properties: {
        transactionId: uuid,
        status: { type: 'string', enum: ['exchanged', 'verified', 'completed', 'cancelled', 'expired'] },
        credentialState: { type: 'string', enum: ['pending', 'active', 'grace', 'revoked'] },
        activeConnected: { type: 'boolean' }
      },
      additionalProperties: false
    },
    AgentVInstallationCommit: {
      type: 'object', required: ['status'],
      properties: { status: { type: 'string', const: 'completed' } },
      additionalProperties: false
    },
    AgentVInstallationRollback: {
      type: 'object', required: ['status'], properties: { status: { type: 'string', const: 'cancelled' } },
      additionalProperties: false
    }
  };
}
