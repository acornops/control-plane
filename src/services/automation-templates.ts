import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementAutomationTemplateSeed } from '../metrics.js';
import { insertWorkspaceAuditEvent } from '../store/repository-audit-events.js';
import {
  completeTemplateInstallation,
  listTemplateInstallations,
  reserveTemplateInstallation,
  type TemplateInstallationRecord
} from '../store/repository-automation-templates.js';
import { withTransaction } from '../store/repository-transaction.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import type { DefinitionOrigin } from '../types/agents.js';
import type { WorkflowCapabilityMode } from '../types/workflows.js';
import type { WorkflowCapabilityRestrictionMode, WorkflowStatus } from '../types/workflows.js';
import type { PromptResourceRequirement } from '../types/prompt-resources.js';
import { refreshAgentReadiness, refreshWorkflowReadiness } from './automation-readiness.js';
import { effectiveWorkflowRuntimePolicy } from './workflow-runtime-policy.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';
import {
  createAgentThroughDefinitionServiceInTransaction,
  createWorkflowThroughDefinitionServiceInTransaction
} from './automation-definition-service.js';

interface AgentTemplate {
  key: string;
  name: string;
  avatarEmoji: string;
  description: string;
  instructions: string;
  semanticCapabilityIds: string[];
  nativeToolIds?: string[];
  targetConstraints?: { targetTypes: Array<'kubernetes' | 'virtual_machine'>; targetIds: string[] };
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  prompt: string;
  agentKeys: string[];
  semanticCapabilityIds: string[];
  capabilityMode: WorkflowCapabilityMode;
  restrictionMode: WorkflowCapabilityRestrictionMode;
  contextGrants?: string[];
  approvalRequirements?: string[];
  status?: WorkflowStatus;
  resourceRequirements?: PromptResourceRequirement[];
  installMode: 'automatic' | 'opt_in';
  setupSteps: string[];
}

interface AutomationTemplateBundle {
  id: string;
  version: number;
  name: string;
  description: string;
  agents: AgentTemplate[];
  workflows: WorkflowTemplate[];
}

export const STARTER_AUTOMATION_TEMPLATE_ID = 'acornops-starter';
export const STARTER_AUTOMATION_TEMPLATE_VERSION = 7;

async function upsertStarterNativeToolMapping(
  client: PoolClient,
  workspaceId: string,
  agentId: string,
  agentVersion: number,
  toolId: string,
  installedBy: string
): Promise<void> {
  const tool = getWorkspaceNativeTool(toolId);
  if (!tool) throw new Error(`Unknown starter native tool ${toolId}`);
  await client.query(
    `INSERT INTO capability_routing_mappings (
       workspace_id,id,capability_id,version,agent_id,agent_version,status,review_state,priority,
       target_types,target_ids,mcp_tools,native_tool_ids,skill_ids,context_grants,created_by,reviewed_by
     ) VALUES ($1,$2,$3,1,$4,$5,'active','reviewed',100,'[]','[]','[]',$6,'[]',$7,$8,$8)
     ON CONFLICT (workspace_id,id) DO UPDATE SET
       capability_id=EXCLUDED.capability_id,agent_version=EXCLUDED.agent_version,status='active',review_state='reviewed',
       native_tool_ids=EXCLUDED.native_tool_ids,
       context_grants=EXCLUDED.context_grants,reviewed_by=EXCLUDED.reviewed_by,
       version=capability_routing_mappings.version+1,updated_at=NOW()`,
    [workspaceId, `native:${agentId}:${tool.id}`, tool.semanticCapabilityId, agentId, agentVersion,
     JSON.stringify([tool.id]),
     JSON.stringify(tool.requiredContextGrant ? [tool.requiredContextGrant] : []), installedBy]
  );
}

export const STARTER_BUNDLE: AutomationTemplateBundle = {
  id: STARTER_AUTOMATION_TEMPLATE_ID,
  version: STARTER_AUTOMATION_TEMPLATE_VERSION,
  name: 'AcornOps workspace defaults',
  description: 'Kubernetes and virtual-machine Agents with target tools, health checks, and opt-in remediation and incident investigation.',
  agents: [
    {
      key: 'kubernetesAgent',
      name: 'Kubernetes Agent',
      avatarEmoji: '☸️',
      description: 'Investigates and safely operates explicitly selected Kubernetes targets.',
      instructions: 'Operate only on the exact Kubernetes target compiled for this run. Use live target evidence, distinguish observations from inferences, require approval before every write, verify changes, and provide rollback guidance.',
      semanticCapabilityIds: [
        'prompt.resources.read',
        'reports.pdf.generate',
        'target.diagnostics.read',
        'target.remediation.write'
      ],
      nativeToolIds: ['prompt.resources.read', 'reports.pdf.generate'],
      targetConstraints: { targetTypes: ['kubernetes'], targetIds: [] }
    },
    {
      key: 'virtualMachineAgent',
      name: 'Virtual Machine Agent',
      avatarEmoji: '🖥️',
      description: 'Investigates explicitly selected Linux virtual-machine targets.',
      instructions: 'Operate only on the exact virtual-machine target compiled for this run. Use live target evidence, distinguish observations from inferences, preserve provenance, disclose missing inputs, and do not make changes.',
      semanticCapabilityIds: [
        'prompt.resources.read',
        'reports.pdf.generate',
        'target.diagnostics.read'
      ],
      nativeToolIds: ['prompt.resources.read', 'reports.pdf.generate'],
      targetConstraints: { targetTypes: ['virtual_machine'], targetIds: [] }
    }
  ],
  workflows: [
    {
      key: 'kubernetesHealth',
      name: 'Kubernetes health check',
      description: 'Inspect one Kubernetes target for workload failures, warning events, resource pressure, and relevant logs.',
      prompt: "Assess the selected Kubernetes target's current health without making changes. Inspect workload readiness and availability, pod restarts, warning events, resource pressure, and relevant recent logs. Cite the exact evidence for each finding, distinguish observations from inferences, call out unavailable evidence, and finish with prioritized safe next actions.",
      agentKeys: ['kubernetesAgent'],
      semanticCapabilityIds: ['target.diagnostics.read'],
      capabilityMode: 'read_only',
      restrictionMode: 'restrict',
      resourceRequirements: [{ type: 'target', minimum: 1, maximum: 1, requiredOperations: ['read'], constraints: { targetTypes: ['kubernetes'], targetIds: [] } }],
      installMode: 'automatic',
      setupSteps: []
    },
    {
      key: 'targetRemediation',
      name: 'Target remediation',
      description: 'Diagnose and safely change one exact target with approval-gated writes.',
      prompt: 'Diagnose the selected Kubernetes target using live evidence. Propose the smallest safe remediation, request approval before each mutation, verify the result, and summarize rollback guidance.',
      agentKeys: ['kubernetesAgent'],
      semanticCapabilityIds: ['target.diagnostics.read', 'target.remediation.write'],
      capabilityMode: 'read_write',
      restrictionMode: 'restrict',
      approvalRequirements: ['Before every write-capable target tool'],
      resourceRequirements: [{ type: 'target', minimum: 1, maximum: 1, requiredOperations: ['read', 'write'], constraints: { targetTypes: ['kubernetes'], targetIds: [] } }],
      status: 'paused',
      installMode: 'opt_in',
      setupSteps: ['Add paused workflow', 'Select an exact Kubernetes target', 'Preview approval-gated tools', 'Activate']
    },
    {
      key: 'virtualMachineHealth',
      name: 'Virtual machine health check',
      description: 'Inspect one Linux VM for host pressure, degraded services, suspicious processes or listeners, and relevant logs.',
      prompt: "Assess the selected Linux virtual machine's current health without making changes. Inspect the host summary, filesystem pressure, top processes, network listeners, degraded systemd services, and relevant allowlisted journal logs. Cite the exact evidence for each finding, distinguish observations from inferences, call out unavailable evidence, and finish with prioritized safe next actions.",
      agentKeys: ['virtualMachineAgent'],
      semanticCapabilityIds: ['target.diagnostics.read'],
      capabilityMode: 'read_only',
      restrictionMode: 'restrict',
      resourceRequirements: [{ type: 'target', minimum: 1, maximum: 1, requiredOperations: ['read'], constraints: { targetTypes: ['virtual_machine'], targetIds: [] } }],
      status: 'active',
      installMode: 'automatic',
      setupSteps: []
    },
    {
      key: 'managedResponse',
      name: 'Incident investigation',
      description: 'Coordinate target diagnostics and incident reporting for an exact target and selected chats.',
      prompt: 'Investigate the selected target and relevant incident context, then produce a provenance-preserving report with findings and safe next actions.',
      agentKeys: ['kubernetesAgent', 'virtualMachineAgent'],
      semanticCapabilityIds: ['prompt.resources.read', 'reports.pdf.generate', 'target.diagnostics.read'],
      capabilityMode: 'read_only',
      restrictionMode: 'restrict',
      resourceRequirements: [
        { type: 'target', minimum: 1, maximum: 1, requiredOperations: ['read'], constraints: { targetTypes: ['kubernetes', 'virtual_machine'], targetIds: [] } },
        { type: 'chat', minimum: 1, maximum: 20, requiredOperations: ['read'] }
      ],
      status: 'paused',
      installMode: 'opt_in',
      setupSteps: ['Add paused workflow', 'Select an exact target and incident chats', 'Preview coordinated access', 'Activate']
    }
  ]
};

const AUTOMATIC_WORKFLOW_TEMPLATES = STARTER_BUNDLE.workflows.filter(
  (template) => template.installMode === 'automatic'
);

export function initialWorkflowTemplateStatus(
  template: Pick<WorkflowTemplate, 'installMode' | 'status'>
): WorkflowStatus {
  return template.status ?? (template.installMode === 'automatic' ? 'active' : 'paused');
}

const AUTOMATIC_AGENT_KEYS = new Set(
  AUTOMATIC_WORKFLOW_TEMPLATES.flatMap((template) => template.agentKeys)
);

let seedFailureStageForTests: 'after_agents' | 'after_workflows' | null = null;

export function overrideStarterAutomationSeedFailureForTests(
  stage: 'after_agents' | 'after_workflows' | null
): void {
  seedFailureStageForTests = stage;
}

function injectSeedFailureForTests(stage: 'after_agents' | 'after_workflows'): void {
  if (config.NODE_ENV === 'test' && seedFailureStageForTests === stage) {
    throw new Error(`Injected starter automation seed failure at ${stage}`);
  }
}

function agentDefinitionOrigin(): DefinitionOrigin {
  return { type: 'manual' };
}

async function deletePendingStarterDefinitions(client: PoolClient, workspaceId: string): Promise<void> {
  const workflowRows = await client.query<{ id: string }>(
    `SELECT id FROM workflow_definitions
     WHERE workspace_id=$1
       AND origin->>'type'='template'
       AND origin->>'templateId'=$2
       AND origin->>'templateVersion'=$3`,
    [workspaceId, STARTER_BUNDLE.id, String(STARTER_BUNDLE.version)]
  );
  const workflowIds = workflowRows.rows.map((row) => row.id);
  if (workflowIds.length > 0) {
    await client.query(
      'DELETE FROM workflow_schedules WHERE workspace_id=$1 AND workflow_id=ANY($2::text[])',
      [workspaceId, workflowIds]
    );
    await client.query(
      'DELETE FROM workflow_sessions WHERE workspace_id=$1 AND workflow_id=ANY($2::text[])',
      [workspaceId, workflowIds]
    );
    await client.query(
      'DELETE FROM workflow_definitions WHERE workspace_id=$1 AND id=ANY($2::text[])',
      [workspaceId, workflowIds]
    );
  }
  await client.query(
    `DELETE FROM agent_definitions
     WHERE workspace_id=$1
       AND origin->>'type'='template'
       AND origin->>'templateId'=$2
       AND origin->>'templateVersion'=$3`,
    [workspaceId, STARTER_BUNDLE.id, String(STARTER_BUNDLE.version)]
  );
}

export async function insertStarterAgent(
  client: PoolClient,
  input: { workspaceId: string; installedBy: string; template: AgentTemplate }
): Promise<string> {
  const targetScope = input.template.targetConstraints
    ? { type: 'selected_target' as const, targetTypes: input.template.targetConstraints.targetTypes }
    : { type: 'workspace' as const };
  const agent = await createAgentThroughDefinitionServiceInTransaction(client, {
    workspaceId: input.workspaceId,
    name: input.template.name,
    avatarEmoji: input.template.avatarEmoji,
    description: input.template.description,
    instructions: input.template.instructions,
    ownerUserId: input.installedBy,
    createdBy: input.installedBy,
    origin: agentDefinitionOrigin(),
    reviewState: 'reviewed',
    providerType: 'internal',
    targetScope,
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes',
    semanticCapabilityIds: input.template.semanticCapabilityIds,
    tools: input.template.nativeToolIds || []
  });
  for (const toolId of input.template.nativeToolIds || []) {
    await upsertStarterNativeToolMapping(client, input.workspaceId, agent.id, agent.version, toolId, input.installedBy);
  }
  return agent.id;
}

export async function insertStarterWorkflow(
  client: PoolClient,
  input: { workspaceId: string; installedBy: string; template: WorkflowTemplate; agentIds: Record<string, string> }
): Promise<string> {
  const capabilityPolicy = {
    mode: input.template.capabilityMode,
    restrictionMode: input.template.restrictionMode,
    semanticCapabilityIds: input.template.semanticCapabilityIds,
    contextGrants: input.template.contextGrants || [],
    ...effectiveWorkflowRuntimePolicy(),
    approvalRequirements: input.template.approvalRequirements || []
  };
  const workflow = await createWorkflowThroughDefinitionServiceInTransaction(client, {
    workspaceId: input.workspaceId,
    name: input.template.name,
    description: input.template.description,
    prompt: input.template.prompt,
    agentIds: input.template.agentKeys.map((key) => input.agentIds[key]),
    resourceRequirements: input.template.resourceRequirements,
    capabilityPolicy,
    tags: [],
    requiredPermissions: [],
    createdBy: input.installedBy,
    origin: { type: 'manual' },
    status: initialWorkflowTemplateStatus(input.template)
  });
  return workflow.id;
}

export async function provisionStarterAutomationInTransaction(
  client: PoolClient,
  input: { workspaceId: string; installedBy: string }
): Promise<{ installation: TemplateInstallationRecord; alreadySeeded: boolean }> {
  const reserved = await reserveTemplateInstallation({
    workspaceId: input.workspaceId,
    templateId: STARTER_BUNDLE.id,
    templateVersion: STARTER_BUNDLE.version,
    installedBy: input.installedBy
  }, client);
  if (reserved.state === 'complete') {
    return { installation: reserved, alreadySeeded: true };
  }

  await deletePendingStarterDefinitions(client, input.workspaceId);
  const agentIds: Record<string, string> = {};
  for (const template of STARTER_BUNDLE.agents.filter((agent) => AUTOMATIC_AGENT_KEYS.has(agent.key))) {
    agentIds[template.key] = await insertStarterAgent(client, {
      workspaceId: input.workspaceId,
      installedBy: input.installedBy,
      template
    });
  }
  injectSeedFailureForTests('after_agents');

  const workflowIds: Record<string, string> = {};
  for (const template of AUTOMATIC_WORKFLOW_TEMPLATES) {
    workflowIds[template.key] = await insertStarterWorkflow(client, {
      workspaceId: input.workspaceId,
      installedBy: input.installedBy,
      template,
      agentIds
    });
  }
  injectSeedFailureForTests('after_workflows');

  const recordIds = {
    ...Object.fromEntries(Object.entries(agentIds).map(([key, id]) => [`agent:${key}`, id])),
    ...Object.fromEntries(Object.entries(workflowIds).map(([key, id]) => [`workflow:${key}`, id]))
  };
  const installation = await completeTemplateInstallation(
    input.workspaceId,
    STARTER_BUNDLE.id,
    recordIds,
    client
  );
  await insertWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'run',
    eventType: 'automation.defaults_created.v1',
    operation: 'write',
    actorUserId: input.installedBy,
    objectType: 'workflow_defaults',
    objectId: STARTER_BUNDLE.id,
    objectName: STARTER_BUNDLE.name,
    summary: 'Default workflows created',
    metadata: {
      defaultSetId: STARTER_BUNDLE.id,
      defaultSetVersion: STARTER_BUNDLE.version,
      visibleAgentCount: Object.keys(agentIds).length,
      workflowCount: Object.keys(workflowIds).length
    }
  }, client);
  return { installation, alreadySeeded: false };
}

export async function refreshStarterAutomationReadiness(
  installation: TemplateInstallationRecord
): Promise<void> {
  const failures: Array<{ recordType: string; recordId: string; error: unknown }> = [];
  for (const [key, recordId] of Object.entries(installation.recordIds)) {
    try {
      if (key.startsWith('agent:')) await refreshAgentReadiness(installation.workspaceId, recordId);
    } catch (error) {
      failures.push({ recordType: 'agent', recordId, error });
    }
  }
  for (const [key, recordId] of Object.entries(installation.recordIds)) {
    try {
      if (key.startsWith('workflow:')) {
        const workflow = await getWorkflowDefinition(installation.workspaceId, recordId);
        if (workflow) await refreshWorkflowReadiness(workflow);
      }
    } catch (error) {
      failures.push({ recordType: 'workflow', recordId, error });
    }
  }
  if (failures.length > 0) {
    logger.warn({
      workspaceId: installation.workspaceId,
      templateId: installation.templateId,
      failures
    }, 'Starter automation readiness refresh completed with failures');
  }
}

function recordSeedSuccess(input: { workspaceId: string; alreadySeeded: boolean }): void {
  if (input.alreadySeeded) return;
  incrementAutomationTemplateSeed(STARTER_BUNDLE.id, 'success');
  logger.info({
    workspaceId: input.workspaceId,
    templateId: STARTER_BUNDLE.id,
    templateVersion: STARTER_BUNDLE.version,
    outcome: 'success',
    visibleAgentCount: AUTOMATIC_AGENT_KEYS.size,
    workflowCount: AUTOMATIC_WORKFLOW_TEMPLATES.length
  }, 'Starter automation seed completed');
}

export function recordStarterAutomationSeedFailure(workspaceId: string, error: unknown): void {
  incrementAutomationTemplateSeed(STARTER_BUNDLE.id, 'failure');
  logger.error({
    err: error,
    workspaceId,
    templateId: STARTER_BUNDLE.id,
    templateVersion: STARTER_BUNDLE.version,
    outcome: 'failure'
  }, 'Starter automation seed failed');
}

export async function provisionStarterAutomation(input: {
  workspaceId: string;
  installedBy: string;
}): Promise<{ installation: TemplateInstallationRecord; alreadySeeded: boolean }> {
  try {
    const result = await withTransaction((client) => provisionStarterAutomationInTransaction(client, input));
    recordSeedSuccess({ workspaceId: input.workspaceId, alreadySeeded: result.alreadySeeded });
    if (!result.alreadySeeded) await refreshStarterAutomationReadiness(result.installation);
    return result;
  } catch (error) {
    recordStarterAutomationSeedFailure(input.workspaceId, error);
    throw error;
  }
}

export function recordStarterAutomationSeedSuccess(workspaceId: string, alreadySeeded: boolean): void {
  recordSeedSuccess({ workspaceId, alreadySeeded });
}
