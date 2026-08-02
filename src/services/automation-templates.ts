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
import type { WorkflowStatus } from '../types/workflows.js';
import { refreshAgentReadiness, refreshWorkflowReadiness } from './automation-readiness.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';
import { syncAgentTargetsBuiltInTools } from './agent-targets-mcp-sync.js';
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
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  prompt: string;
  agentKeys: string[];
  status?: WorkflowStatus;
  installMode: 'automatic' | 'opt_in';
  setupSteps: string[];
}

interface AutomationTemplateBundle {
  id: string;
  name: string;
  description: string;
  agents: AgentTemplate[];
  workflows: WorkflowTemplate[];
}

export const STARTER_AUTOMATION_TEMPLATE_ID = 'acornops-starter';

async function upsertStarterNativeToolMapping(
  client: PoolClient,
  workspaceId: string,
  agentId: string,
  toolId: string,
  installedBy: string
): Promise<void> {
  const tool = getWorkspaceNativeTool(toolId);
  if (!tool) throw new Error(`Unknown starter native tool ${toolId}`);
  await client.query(
     `INSERT INTO capability_routing_mappings (
       workspace_id,id,capability_id,agent_id,status,review_state,priority,
       mcp_tools,native_tool_ids,skill_ids,context_grants,created_by,reviewed_by
     ) VALUES ($1,$2,$3,$4,'active','reviewed',100,'[]',$5,'[]',$6,$7,$7)
     ON CONFLICT (workspace_id,id) DO UPDATE SET
       capability_id=EXCLUDED.capability_id,status='active',review_state='reviewed',
       native_tool_ids=EXCLUDED.native_tool_ids,
       context_grants=EXCLUDED.context_grants,reviewed_by=EXCLUDED.reviewed_by,
       updated_at=NOW()`,
    [workspaceId, `native:${agentId}:${tool.id}`, tool.semanticCapabilityId, agentId,
     JSON.stringify([tool.id]),
     JSON.stringify(tool.requiredContextGrant ? [tool.requiredContextGrant] : []), installedBy]
  );
}

export const STARTER_BUNDLE: AutomationTemplateBundle = {
  id: STARTER_AUTOMATION_TEMPLATE_ID,
  name: 'AcornOps workspace defaults',
  description: 'Kubernetes and virtual-machine Agents with MCP tools, health checks, and opt-in remediation and incident investigation.',
  agents: [
    {
      key: 'kubernetesAgent',
      name: 'Kubernetes Agent',
      avatarEmoji: '☸️',
      description: 'Investigates and safely operates Kubernetes environments identified in the request.',
      instructions: 'Use the environment identified by the request when calling relevant MCP tools. Do not guess when a resource name is ambiguous. Use live evidence, distinguish observations from inferences, require approval before every write, verify changes, and provide rollback guidance.',
      semanticCapabilityIds: [
        'documents.create',
        'infrastructure.diagnostics.read',
        'infrastructure.remediation.write'
      ],
      nativeToolIds: ['documents.create']
    },
    {
      key: 'virtualMachineAgent',
      name: 'Virtual Machine Agent',
      avatarEmoji: '🖥️',
      description: 'Investigates Linux virtual machines identified in the request.',
      instructions: 'Use the machine identified by the request when calling relevant MCP tools. Do not guess when a resource name is ambiguous. Use live evidence, distinguish observations from inferences, preserve provenance, disclose missing inputs, and do not make changes.',
      semanticCapabilityIds: [
        'documents.create',
        'infrastructure.diagnostics.read'
      ],
      nativeToolIds: ['documents.create']
    }
  ],
  workflows: [
    {
      key: 'kubernetesHealth',
      name: 'Kubernetes health check',
      description: 'Inspect available Kubernetes environments for workload failures, warning events, resource pressure, and relevant logs.',
      prompt: "Assess the available Kubernetes environments' current health without making changes. Use the Kubernetes Agent's MCP tools where relevant. Inspect workload readiness and availability, pod restarts, warning events, resource pressure, and relevant recent logs. Cite the exact environment and evidence for each finding, distinguish observations from inferences, call out unavailable evidence, and finish with prioritized safe next actions.",
      agentKeys: ['kubernetesAgent'],
      installMode: 'automatic',
      setupSteps: []
    },
    {
      key: 'infrastructureRemediation',
      name: 'Infrastructure remediation',
      description: 'Diagnose and safely change a Kubernetes environment named in the request with approval-gated writes.',
      prompt: 'Diagnose the Kubernetes environment named in this request using live evidence. If the environment is missing or ambiguous, explain what is needed instead of guessing. Propose the smallest safe remediation, request approval before each mutation, verify the result, and summarize rollback guidance.',
      agentKeys: ['kubernetesAgent'],
      status: 'paused',
      installMode: 'opt_in',
      setupSteps: ['Add paused workflow', 'Review approval-gated tools', 'Activate']
    },
    {
      key: 'virtualMachineHealth',
      name: 'Virtual machine health check',
      description: 'Inspect available Linux VMs for host pressure, degraded services, suspicious processes or listeners, and relevant logs.',
      prompt: "Assess the available Linux virtual machines' current health without making changes. Use the Virtual Machine Agent's MCP tools where relevant. Inspect the host summary, filesystem pressure, top processes, network listeners, degraded systemd services, and relevant allowlisted journal logs. Cite the exact machine and evidence for each finding, distinguish observations from inferences, call out unavailable evidence, and finish with prioritized safe next actions.",
      agentKeys: ['virtualMachineAgent'],
      status: 'active',
      installMode: 'automatic',
      setupSteps: []
    },
    {
      key: 'managedResponse',
      name: 'Incident investigation',
      description: 'Coordinate diagnostics and incident reporting from infrastructure and context named in the request.',
      prompt: 'Investigate the infrastructure and incident context named in this request. Do not guess when a resource is missing or ambiguous. Produce a provenance-preserving report with findings and safe next actions.',
      agentKeys: ['kubernetesAgent', 'virtualMachineAgent'],
      status: 'paused',
      installMode: 'opt_in',
      setupSteps: ['Add paused workflow', 'Review coordinated access', 'Activate']
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

export async function insertStarterAgent(
  client: PoolClient,
  input: { workspaceId: string; installedBy: string; template: AgentTemplate }
): Promise<string> {
  const agent = await createAgentThroughDefinitionServiceInTransaction(client, {
    workspaceId: input.workspaceId,
    name: input.template.name,
    avatarEmoji: input.template.avatarEmoji,
    description: input.template.description,
    instructions: input.template.instructions,
    ownerUserId: input.installedBy,
    createdBy: input.installedBy,
    reviewState: 'reviewed',
    providerType: 'internal',
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes',
    semanticCapabilityIds: input.template.semanticCapabilityIds,
    tools: input.template.nativeToolIds || []
  });
  for (const toolId of input.template.nativeToolIds || []) {
    await upsertStarterNativeToolMapping(client, input.workspaceId, agent.id, toolId, input.installedBy);
  }
  return agent.id;
}

export async function insertStarterWorkflow(
  client: PoolClient,
  input: { workspaceId: string; installedBy: string; template: WorkflowTemplate; agentIds: Record<string, string> }
): Promise<string> {
  const workflow = await createWorkflowThroughDefinitionServiceInTransaction(client, {
    workspaceId: input.workspaceId,
    name: input.template.name,
    description: input.template.description,
    prompt: input.template.prompt,
    agentIds: input.template.agentKeys.map((key) => input.agentIds[key]),
    tags: [],
    createdBy: input.installedBy,
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
    installedBy: input.installedBy
  }, client);
  if (reserved.state === 'complete') {
    return { installation: reserved, alreadySeeded: true };
  }

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
      if (key.startsWith('agent:')) {
        const synced = await syncAgentTargetsBuiltInTools(installation.workspaceId, recordId);
        if (!synced.ok) throw new Error(synced.error || 'Agent Targets MCP synchronization failed');
        await refreshAgentReadiness(installation.workspaceId, recordId);
      }
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
