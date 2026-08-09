import { JsonSchema, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';
import { targetSummarySchema } from './schema-components-common.js';

export function buildVirtualMachineInstallSchemas(): Record<string, JsonSchema> {
  return {
    VirtualMachine: {
      allOf: [targetSummarySchema],
      required: [
        'agentAccessMode', 'restartServices', 'pendingAgentAccessPolicy',
        'permissionMode', 'permissionModeOverride', 'permissionModeSource'
      ],
      properties: {
        hostname: { type: 'string' },
        osFamily: { type: 'string', enum: ['linux'] },
        serviceManager: { type: 'string', enum: ['systemd'] },
        allowedLogSources: stringArray,
        agentAccessMode: { type: 'string', enum: ['read_only', 'read_write'] },
        restartServices: stringArray,
        pendingAgentAccessPolicy: { oneOf: [schemaRef('AgentVAccessPolicy'), { type: 'null' }] },
        permissionMode: { type: 'string', enum: ['read_only', 'ask_before_changes', 'auto_allowed_changes'] },
        permissionModeOverride: {
          type: ['string', 'null'],
          enum: ['read_only', 'ask_before_changes', 'auto_allowed_changes', null]
        },
        permissionModeSource: { type: 'string', enum: ['virtual_machine_override', 'deployment_default'] }
      }
    },
    VirtualMachinePage: pageOf('VirtualMachine'),
    VirtualMachineRegistration: {
      type: 'object',
      required: ['virtualMachine', 'installInstructions'],
      properties: {
        virtualMachine: schemaRef('VirtualMachine'),
        installInstructions: schemaRef('VirtualMachineInstallInstructions')
      },
      additionalProperties: false
    },
    AgentVAccessPolicy: {
      type: 'object',
      required: ['accessMode', 'restartServices'],
      properties: {
        accessMode: { type: 'string', enum: ['read_only', 'read_write'] },
        restartServices: {
          type: 'array',
          maxItems: 32,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}\\.service$' }
        }
      },
      additionalProperties: false
    },
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
    VirtualMachineAgentAccessPolicyUpdate: {
      type: 'object',
      required: ['virtualMachine', 'installInstructions'],
      properties: {
        virtualMachine: schemaRef('VirtualMachine'),
        installInstructions: schemaRef('VirtualMachineInstallInstructions')
      },
      additionalProperties: false
    },
    AgentVEnrollmentExchange: {
      type: 'object',
      required: ['transactionId', 'transactionSecret', 'agentKey', 'purpose', 'accessPolicy'],
      properties: {
        transactionId: uuid,
        transactionSecret: { type: 'string', writeOnly: true },
        agentKey: { type: 'string', writeOnly: true },
        purpose: { type: 'string', enum: ['initial', 'replace'] },
        accessPolicy: schemaRef('AgentVAccessPolicy')
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
