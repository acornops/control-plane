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
import type { AgentDefinitionKind, DefinitionOrigin } from '../types/agents.js';
import type { WorkflowCapabilityMode, WorkflowTargetConstraints } from '../types/workflows.js';
import type { WorkflowCapabilityRestrictionMode, WorkflowInputDefinition, WorkflowStatus } from '../types/workflows.js';
import { refreshAgentReadiness, refreshWorkflowReadiness } from './automation-readiness.js';
import {
  upgradeStarterAutomationV2InTransaction,
  upgradeStarterAutomationV3InTransaction,
  upgradeStarterAutomationV4InTransaction,
  upsertStarterNativeToolMapping
} from './automation-template-v2-upgrade.js';
import {
  createAgentThroughDefinitionServiceInTransaction,
  createWorkflowThroughDefinitionServiceInTransaction
} from './automation-definition-service.js';

interface AgentTemplate {
  key: string;
  name: string;
  description: string;
  instructions: string;
  kind: AgentDefinitionKind;
  semanticCapabilityIds: string[];
  nativeToolIds?: string[];
  specialistKeys?: string[];
  targetConstraints?: WorkflowTargetConstraints;
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  prompt: string;
  agentKeys: string[];
  semanticCapabilityIds: string[];
  capabilityMode: WorkflowCapabilityMode;
  restrictionMode?: WorkflowCapabilityRestrictionMode;
  contextGrants?: string[];
  inputs?: WorkflowInputDefinition[];
  retentionDays?: number;
  approvalRequirements?: string[];
  status?: WorkflowStatus;
  targetConstraints?: WorkflowTargetConstraints;
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
export const STARTER_AUTOMATION_TEMPLATE_VERSION = 4;

export const STARTER_BUNDLE: AutomationTemplateBundle = {
  id: STARTER_AUTOMATION_TEMPLATE_ID,
  version: STARTER_AUTOMATION_TEMPLATE_VERSION,
  name: 'AcornOps starter automation',
  description: 'Target diagnostics, approval-gated target remediation, incident reporting, and coordinated investigation starters.',
  agents: [
    {
      key: 'targetDiagnostics',
      name: 'Target Diagnostics',
      description: 'Collects diagnostic evidence from an explicitly selected target.',
      instructions: 'Inspect only the exact target scope compiled for this run. Cite observed evidence and distinguish observations from inferences.',
      kind: 'specialist',
      semanticCapabilityIds: ['target.diagnostics.read'],
      targetConstraints: { targetTypes: ['kubernetes', 'virtual_machine'], targetIds: [] }
    },
    {
      key: 'targetRemediation',
      name: 'Target Remediation',
      description: 'Diagnoses and safely changes an explicitly selected target.',
      instructions: 'Inspect the exact compiled target before changing it. Propose the smallest safe change, require approval for every write, verify the result, and provide rollback guidance.',
      kind: 'specialist',
      semanticCapabilityIds: ['target.diagnostics.read', 'target.remediation.write'],
      targetConstraints: { targetTypes: ['kubernetes'], targetIds: [] }
    },
    {
      key: 'incidentReporter',
      name: 'Incident Reporter',
      description: 'Produces an incident report from explicitly granted evidence.',
      instructions: 'Use only evidence and context present in the compiled scope. Preserve provenance and disclose missing inputs.',
      kind: 'specialist',
      semanticCapabilityIds: ['chat.sessions.read_selected', 'reports.pdf.generate'],
      nativeToolIds: ['chat.sessions.read_selected', 'reports.pdf.generate']
    }
  ],
  workflows: [
    {
      key: 'targetDiagnostics',
      name: 'Target diagnostics',
      description: 'Inspect one exact target using live diagnostic evidence.',
      prompt: 'Inspect @target[Target name] using live diagnostic evidence and summarize findings and safe next actions.',
      agentKeys: ['targetDiagnostics'],
      semanticCapabilityIds: ['target.diagnostics.read'],
      capabilityMode: 'read_only',
      targetConstraints: { targetTypes: ['kubernetes', 'virtual_machine'], targetIds: [] },
      installMode: 'automatic',
      setupSteps: []
    },
    {
      key: 'targetRemediation',
      name: 'Target remediation',
      description: 'Diagnose and safely change one exact target with approval-gated writes.',
      prompt: 'Diagnose @target[Target name] using live evidence. Propose the smallest safe change, request approval before each mutation, verify the result, and summarize rollback guidance.',
      agentKeys: ['targetRemediation'],
      semanticCapabilityIds: ['target.diagnostics.read', 'target.remediation.write'],
      capabilityMode: 'read_write',
      approvalRequirements: ['Before every write-capable target tool'],
      targetConstraints: { targetTypes: ['kubernetes'], targetIds: [] },
      inputs: [{ name: 'requestedChange', label: 'Requested change', type: 'text', required: true }],
      status: 'paused',
      installMode: 'opt_in',
      setupSteps: ['Install paused workflow', 'Select an exact Kubernetes target', 'Preview approval-gated tools', 'Activate']
    },
    {
      key: 'incidentReporter',
      name: 'Incident report',
      description: 'Generate an incident report from explicitly granted evidence.',
      prompt: 'Generate an incident report with provenance from only the granted evidence.',
      agentKeys: ['incidentReporter'],
      semanticCapabilityIds: [],
      capabilityMode: 'read_only',
      restrictionMode: 'inherit',
      contextGrants: ['selected_chat_sessions'],
      inputs: [
        { name: 'incidentChats', label: 'Incident chats', type: 'chat_session_list', required: true, optionSource: 'chatSessions' },
        { name: 'title', label: 'Report title', type: 'text', required: false }
      ],
      retentionDays: 180,
      status: 'active',
      installMode: 'automatic',
      setupSteps: []
    },
    {
      key: 'managedResponse',
      name: 'Incident investigation',
      description: 'Coordinate target diagnostics and incident reporting for an exact target and selected chats.',
      prompt: 'Investigate the exact selected target and selected incident chats, then produce a provenance-preserving report.',
      agentKeys: ['targetDiagnostics', 'incidentReporter'],
      semanticCapabilityIds: ['chat.sessions.read_selected', 'reports.pdf.generate', 'target.diagnostics.read'],
      capabilityMode: 'read_only',
      contextGrants: ['selected_chat_sessions'],
      inputs: [
        { name: 'incidentChats', label: 'Incident chats', type: 'chat_session_list', required: true, optionSource: 'chatSessions' },
        { name: 'investigationQuestion', label: 'Investigation question', type: 'text', required: true }
      ],
      targetConstraints: { targetTypes: ['kubernetes', 'virtual_machine'], targetIds: [] },
      status: 'paused',
      installMode: 'opt_in',
      setupSteps: ['Install paused workflow', 'Select an exact target and incident chats', 'Preview coordinated access', 'Activate']
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

const AUTOMATIC_INTERNAL_AGENT_COUNT = AUTOMATIC_WORKFLOW_TEMPLATES.length > 0 ? 1 : 0;

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

function definitionOrigin(): DefinitionOrigin {
  return {
    type: 'template',
    templateId: STARTER_BUNDLE.id,
    templateVersion: STARTER_BUNDLE.version
  };
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
  input: { workspaceId: string; installedBy: string; template: AgentTemplate; delegateAgentIds: string[] }
): Promise<string> {
  const targetScope = input.template.targetConstraints
    ? { type: 'selected_target' as const, targetTypes: input.template.targetConstraints.targetTypes }
    : { type: 'workspace' as const };
  const agent = await createAgentThroughDefinitionServiceInTransaction(client, {
    workspaceId: input.workspaceId,
    name: input.template.name,
    description: input.template.description,
    instructions: input.template.instructions,
    ownerUserId: input.installedBy,
    createdBy: input.installedBy,
    origin: definitionOrigin(),
    kind: input.template.kind,
    reviewState: 'reviewed',
    providerType: 'internal',
    targetScope,
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes',
    semanticCapabilityIds: input.template.semanticCapabilityIds,
    tools: input.template.nativeToolIds || [],
    delegateAgentIds: input.delegateAgentIds
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
    restrictionMode: input.template.restrictionMode || 'restrict',
    semanticCapabilityIds: input.template.semanticCapabilityIds,
    contextGrants: input.template.contextGrants || [],
    maxRuntimeSeconds: 900,
    retentionDays: input.template.retentionDays || 90,
    approvalRequirements: input.template.approvalRequirements || []
  };
  const workflow = await createWorkflowThroughDefinitionServiceInTransaction(client, {
    workspaceId: input.workspaceId,
    name: input.template.name,
    description: input.template.description,
    prompt: input.template.prompt,
    agentIds: input.template.agentKeys.map((key) => input.agentIds[key]),
    targetConstraints: input.template.targetConstraints,
    capabilityPolicy,
    tags: [],
    inputs: input.template.inputs || [],
    requiredPermissions: [],
    createdBy: input.installedBy,
    origin: definitionOrigin(),
    status: initialWorkflowTemplateStatus(input.template)
  });
  return workflow.id;
}

export async function seedStarterAutomationV1InTransaction(
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
    if (reserved.templateVersion >= STARTER_BUNDLE.version) {
      return { installation: reserved, alreadySeeded: true };
    }
    let upgraded = reserved;
    if (upgraded.templateVersion < 2) {
      upgraded = await upgradeStarterAutomationV2InTransaction(client, upgraded, STARTER_BUNDLE);
    }
    if (upgraded.templateVersion < 3) {
      upgraded = await upgradeStarterAutomationV3InTransaction(client, upgraded, STARTER_BUNDLE);
    }
    if (upgraded.templateVersion < 4) {
      upgraded = await upgradeStarterAutomationV4InTransaction(client, upgraded, STARTER_BUNDLE);
    }
    return {
      installation: upgraded,
      alreadySeeded: false
    };
  }

  await deletePendingStarterDefinitions(client, input.workspaceId);
  const agentIds: Record<string, string> = {};
  for (const template of STARTER_BUNDLE.agents.filter((agent) => (
    agent.kind === 'specialist' && AUTOMATIC_AGENT_KEYS.has(agent.key)
  ))) {
    agentIds[template.key] = await insertStarterAgent(client, {
      workspaceId: input.workspaceId,
      installedBy: input.installedBy,
      template,
      delegateAgentIds: []
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
    eventType: 'automation.template_seeded.v1',
    operation: 'write',
    actorUserId: input.installedBy,
    objectType: 'automation_template',
    objectId: STARTER_BUNDLE.id,
    objectName: STARTER_BUNDLE.name,
    summary: 'Starter automation provisioned',
    metadata: {
      templateId: STARTER_BUNDLE.id,
      templateVersion: STARTER_BUNDLE.version,
      visibleAgentCount: Object.keys(agentIds).length,
      internalAgentCount: AUTOMATIC_INTERNAL_AGENT_COUNT,
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
    internalAgentCount: AUTOMATIC_INTERNAL_AGENT_COUNT,
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

export async function seedStarterAutomationV1(input: {
  workspaceId: string;
  installedBy: string;
}): Promise<{ installation: TemplateInstallationRecord; alreadySeeded: boolean }> {
  try {
    const result = await withTransaction((client) => seedStarterAutomationV1InTransaction(client, input));
    recordSeedSuccess({ workspaceId: input.workspaceId, alreadySeeded: result.alreadySeeded });
    if (!result.alreadySeeded) await refreshStarterAutomationReadiness(result.installation);
    return result;
  } catch (error) {
    recordStarterAutomationSeedFailure(input.workspaceId, error);
    throw error;
  }
}

export async function backfillStarterAutomationV1(): Promise<void> {
  const result = await db.query<{ workspace_id: string; installed_by: string }>(
    `SELECT workspace.id AS workspace_id,
            COALESCE(installation.installed_by, workspace.created_by) AS installed_by
     FROM workspaces workspace
     LEFT JOIN automation_template_installations installation
       ON installation.workspace_id=workspace.id AND installation.template_id=$1
     WHERE installation.state IS DISTINCT FROM 'complete'
        OR installation.template_version < $2
     ORDER BY workspace.id`,
    [STARTER_BUNDLE.id, STARTER_BUNDLE.version]
  );
  let seeded = 0;
  for (const workspace of result.rows) {
    const seed = await seedStarterAutomationV1({
      workspaceId: workspace.workspace_id,
      installedBy: workspace.installed_by
    });
    if (!seed.alreadySeeded) seeded += 1;
  }
  logger.info({
    templateId: STARTER_BUNDLE.id,
    templateVersion: STARTER_BUNDLE.version,
    eligibleWorkspaceCount: result.rows.length,
    seededWorkspaceCount: seeded
  }, 'Starter automation startup backfill completed');
}

export function recordStarterAutomationSeedSuccess(workspaceId: string, alreadySeeded: boolean): void {
  recordSeedSuccess({ workspaceId, alreadySeeded });
}
