import { db } from '../infra/db.js';
import { insertWorkspaceAuditEvent } from '../store/repository-audit-events.js';
import {
  listTemplateInstallations,
  reserveTemplateInstallation,
  updateTemplateInstallationRecordIds,
  type TemplateInstallationRecord
} from '../store/repository-automation-templates.js';
import { withTransaction } from '../store/repository-transaction.js';
import { getWorkflowDefinition } from '../store/repository-workflows.js';
import {
  computeWorkflowReadiness,
  refreshAgentReadiness,
  refreshWorkflowReadiness
} from './automation-readiness.js';
import {
  initialWorkflowTemplateStatus,
  insertStarterAgent,
  insertStarterWorkflow,
  STARTER_BUNDLE,
  type WorkflowTemplate
} from './automation-templates.js';

const PUBLIC_TEMPLATE_IDS: Record<string, string> = {
  targetDiagnostics: 'target-diagnostics',
  incidentReporter: 'incident-report',
  targetRemediation: 'target-remediation',
  managedResponse: 'incident-investigation'
};

export async function listAutomationTemplateBundles(workspaceId?: string): Promise<Array<{
  id: string;
  version: number;
  name: string;
  description: string;
  installMode: 'automatic' | 'opt_in';
  installationStatus: 'not_installed' | 'needs_setup' | 'ready' | 'active';
  setupSteps: string[];
  blockerCodes: string[];
  workflowId?: string;
}>> {
  const installation = workspaceId
    ? (await listTemplateInstallations(workspaceId)).find((item) => item.templateId === STARTER_BUNDLE.id)
    : undefined;
  return Promise.all(STARTER_BUNDLE.workflows.map(async (template) => {
    const workflowId = installation?.recordIds[`workflow:${template.key}`];
    const workflow = workspaceId && workflowId ? await getWorkflowDefinition(workspaceId, workflowId) : undefined;
    const installationStatus = !workflow
      ? 'not_installed' as const
      : workflow.status === 'active' && workflow.readiness?.status === 'ready'
        ? 'active' as const
        : workflow.readiness?.status === 'ready'
          ? 'ready' as const
          : 'needs_setup' as const;
    const blockerCodes = !workflow
      ? ['TEMPLATE_NOT_INSTALLED']
      : workflow.readiness?.status === 'ready'
        ? []
        : ['WORKFLOW_PREREQUISITES_UNAVAILABLE'];
    return {
      id: PUBLIC_TEMPLATE_IDS[template.key],
      version: STARTER_BUNDLE.version,
      name: template.name,
      description: template.description,
      installMode: template.installMode,
      installationStatus,
      setupSteps: template.setupSteps,
      blockerCodes,
      ...(workflowId ? { workflowId } : {})
    };
  }));
}

export async function getAutomationTemplateInstallations(workspaceId: string): Promise<TemplateInstallationRecord[]> {
  return listTemplateInstallations(workspaceId);
}

export function automationTemplateByPublicId(templateId: string): WorkflowTemplate | undefined {
  return STARTER_BUNDLE.workflows.find((template) => PUBLIC_TEMPLATE_IDS[template.key] === templateId);
}

export async function getInstalledAutomationTemplate(
  workspaceId: string,
  templateId: string
): Promise<{ template: WorkflowTemplate; workflowId?: string; agentIds: Record<string, string> } | null> {
  const template = automationTemplateByPublicId(templateId);
  if (!template) return null;
  const installation = (await listTemplateInstallations(workspaceId))
    .find((item) => item.templateId === STARTER_BUNDLE.id);
  if (!installation) return { template, agentIds: {} };
  return {
    template,
    workflowId: installation.recordIds[`workflow:${template.key}`],
    agentIds: Object.fromEntries(Object.entries(installation.recordIds)
      .filter(([key]) => key.startsWith('agent:'))
      .map(([key, id]) => [key.slice('agent:'.length), id]))
  };
}

export async function installAutomationTemplate(input: {
  workspaceId: string;
  templateId: string;
  installedBy: string;
}): Promise<{ workflowId: string; alreadyInstalled: boolean }> {
  const template = automationTemplateByPublicId(input.templateId);
  if (!template) throw new Error('AUTOMATION_TEMPLATE_NOT_FOUND');
  const result = await withTransaction(async (client) => {
    const installation = await reserveTemplateInstallation({
      workspaceId: input.workspaceId,
      templateId: STARTER_BUNDLE.id,
      templateVersion: STARTER_BUNDLE.version,
      installedBy: input.installedBy
    }, client);
    const recordIds = { ...(installation.recordIds || {}) };
    const existingId = recordIds[`workflow:${template.key}`];
    if (existingId && await getWorkflowDefinition(input.workspaceId, existingId)) {
      return { workflowId: existingId, alreadyInstalled: true };
    }
    const agentIds: Record<string, string> = {};
    for (const agentKey of template.agentKeys) {
      const existingAgentId = recordIds[`agent:${agentKey}`];
      if (existingAgentId) {
        agentIds[agentKey] = existingAgentId;
        continue;
      }
      const agentTemplate = STARTER_BUNDLE.agents.find((candidate) => candidate.key === agentKey);
      if (!agentTemplate) throw new Error(`Missing Agent template ${agentKey}`);
      agentIds[agentKey] = await insertStarterAgent(client, {
        workspaceId: input.workspaceId,
        installedBy: input.installedBy,
        template: agentTemplate
      });
      recordIds[`agent:${agentKey}`] = agentIds[agentKey];
    }
    const workflowId = await insertStarterWorkflow(client, {
      workspaceId: input.workspaceId,
      installedBy: input.installedBy,
      template: { ...template, status: initialWorkflowTemplateStatus(template) },
      agentIds
    });
    recordIds[`workflow:${template.key}`] = workflowId;
    await updateTemplateInstallationRecordIds(input.workspaceId, STARTER_BUNDLE.id, recordIds, client);
    await insertWorkspaceAuditEvent({
      workspaceId: input.workspaceId,
      category: 'run', eventType: 'automation.template_installed.v1', operation: 'write',
      actorUserId: input.installedBy, objectType: 'automation_template', objectId: input.templateId,
      objectName: template.name, summary: 'Automation template installed',
      metadata: { templateId: input.templateId, templateVersion: STARTER_BUNDLE.version, installMode: template.installMode }
    }, client);
    return { workflowId, alreadyInstalled: false };
  });
  const installed = await getInstalledAutomationTemplate(input.workspaceId, input.templateId);
  for (const agentId of Object.values(installed?.agentIds || {})) {
    await refreshAgentReadiness(input.workspaceId, agentId);
  }
  const workflow = await getWorkflowDefinition(input.workspaceId, result.workflowId);
  if (workflow) await refreshWorkflowReadiness(workflow);
  return result;
}

export async function activateAutomationTemplate(input: {
  workspaceId: string;
  templateId: string;
  activatedBy: string;
}): Promise<{ workflowId: string; status: 'active' }> {
  const installed = await getInstalledAutomationTemplate(input.workspaceId, input.templateId);
  if (!installed?.workflowId) throw new Error('AUTOMATION_TEMPLATE_NOT_INSTALLED');
  const workflow = await getWorkflowDefinition(input.workspaceId, installed.workflowId);
  if (!workflow) throw new Error('AUTOMATION_TEMPLATE_NOT_INSTALLED');
  const readiness = await computeWorkflowReadiness(workflow);
  if (readiness.status !== 'ready') throw new Error('AUTOMATION_TEMPLATE_PREREQUISITES_UNAVAILABLE');
  await db.query(
    `UPDATE workflow_definitions SET status='active',version=version+1,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2`,
    [input.workspaceId, workflow.id]
  );
  await insertWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'run', eventType: 'automation.template_activated.v1', operation: 'write',
    actorUserId: input.activatedBy, objectType: 'automation_template', objectId: input.templateId,
    objectName: workflow.name, summary: 'Automation template activated',
    metadata: { templateId: input.templateId, workflowId: workflow.id, workflowVersion: workflow.version + 1 }
  });
  return { workflowId: workflow.id, status: 'active' };
}
