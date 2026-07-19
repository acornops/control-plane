import type { PoolClient } from 'pg';
import { insertWorkspaceAuditEvent } from '../store/repository-audit-events.js';
import {
  mapTemplateInstallation,
  type TemplateInstallationRecord
} from '../store/repository-automation-templates.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';

interface StarterTemplateIdentity {
  id: string;
  name: string;
}

export async function upsertStarterNativeToolMapping(
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
       target_types,target_ids,mcp_tools,native_tool_ids,invocation_scopes,skill_ids,context_grants,created_by,reviewed_by
     ) VALUES ($1,$2,$3,1,$4,$5,'active','reviewed',100,'[]','[]','[]',$6,$7,'[]',$8,$9,$9)
     ON CONFLICT (workspace_id,id) DO UPDATE SET
       capability_id=EXCLUDED.capability_id,agent_version=EXCLUDED.agent_version,status='active',review_state='reviewed',
       native_tool_ids=EXCLUDED.native_tool_ids,invocation_scopes=EXCLUDED.invocation_scopes,
       context_grants=EXCLUDED.context_grants,reviewed_by=EXCLUDED.reviewed_by,
       version=capability_routing_mappings.version+1,updated_at=NOW()`,
    [workspaceId, `native:${agentId}:${tool.id}`, tool.semanticCapabilityId, agentId, agentVersion,
     JSON.stringify([tool.id]), JSON.stringify(tool.invocationScopes),
     JSON.stringify(tool.requiredContextGrant ? [tool.requiredContextGrant] : []), installedBy]
  );
}

export async function upgradeStarterAutomationV2InTransaction(
  client: PoolClient,
  installation: TemplateInstallationRecord,
  template: StarterTemplateIdentity
): Promise<TemplateInstallationRecord> {
  const recordIds = installation.recordIds || {};
  const incidentAgentId = recordIds['agent:incidentReporter'];
  if (incidentAgentId) {
    const updated = await client.query<{ version: number }>(
      `UPDATE agent_definitions
       SET origin=jsonb_set(origin,'{templateVersion}','2'::jsonb,true),
           tools=(SELECT jsonb_agg(value ORDER BY value) FROM (
             SELECT DISTINCT value FROM jsonb_array_elements_text(
               COALESCE(tools,'[]'::jsonb) || '["chat.sessions.read_selected","reports.pdf.generate"]'::jsonb
             ) value
           ) values),
           semantic_capability_ids=(SELECT jsonb_agg(value ORDER BY value) FROM (
             SELECT DISTINCT value FROM jsonb_array_elements_text(
               (COALESCE(semantic_capability_ids,'[]'::jsonb) - 'incident.report.generate')
               || '["chat.sessions.read_selected","reports.pdf.generate"]'::jsonb
             ) value
           ) values),
           version=version+1,readiness_status='needs_setup',readiness_reasons=$3,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 RETURNING version`,
      [installation.workspaceId, incidentAgentId,
       JSON.stringify(['Starter native-tool mappings were upgraded and readiness is being recomputed.'])]
    );
    if (updated.rowCount) {
      const agentVersion = updated.rows[0].version;
      await client.query(
        `UPDATE capability_routing_mappings SET agent_version=$3,version=version+1,updated_at=NOW()
         WHERE workspace_id=$1 AND agent_id=$2 AND status='active'`,
        [installation.workspaceId, incidentAgentId, agentVersion]
      );
      for (const toolId of ['chat.sessions.read_selected', 'reports.pdf.generate']) {
        await upsertStarterNativeToolMapping(
          client, installation.workspaceId, incidentAgentId, agentVersion, toolId, installation.installedBy
        );
      }
    }
  }

  const incidentWorkflowId = recordIds['workflow:incidentReporter'];
  if (incidentWorkflowId) {
    await client.query(
      `UPDATE workflow_definitions
       SET origin=jsonb_set(origin,'{templateVersion}','2'::jsonb,true),capability_policy=$3,inputs=$4,
           status=CASE WHEN status='draft' AND version=1 THEN 'active' ELSE status END,
           version=version+1,readiness_status='needs_setup',readiness_reasons=$5,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2`,
      [installation.workspaceId, incidentWorkflowId, {
        mode: 'read_only', restrictionMode: 'inherit', semanticCapabilityIds: [],
        contextGrants: ['selected_chat_sessions'], maxRuntimeSeconds: 900, retentionDays: 180,
        approvalRequirements: ['Before reading selected incident chats']
      }, JSON.stringify([{
        name: 'incidentChats', label: 'Incident chats', type: 'chat_session_list',
        required: true, optionSource: 'chatSessions'
      }]), JSON.stringify(['Starter Incident Report capabilities were upgraded and readiness is being recomputed.'])]
    );
  }

  const managedWorkflowId = recordIds['workflow:managedResponse'];
  if (managedWorkflowId) {
    await client.query(
      `UPDATE workflow_definitions
       SET origin=jsonb_set(origin,'{templateVersion}','2'::jsonb,true),
           capability_policy=jsonb_set(
             jsonb_set(capability_policy,'{restrictionMode}','"restrict"'::jsonb,true),
             '{semanticCapabilityIds}',
             (COALESCE(capability_policy->'semanticCapabilityIds','[]'::jsonb)
               - 'incident.report.generate'::text)
               || '["chat.sessions.read_selected","reports.pdf.generate"]'::jsonb,
             true
           ),version=version+1,readiness_status='needs_setup',readiness_reasons=$3,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2`,
      [installation.workspaceId, managedWorkflowId,
       JSON.stringify(['Starter capability restrictions were upgraded and readiness is being recomputed.'])]
    );
  }

  await client.query(
    `UPDATE agent_definitions SET origin=jsonb_set(origin,'{templateVersion}','2'::jsonb,true),updated_at=NOW()
     WHERE workspace_id=$1 AND id=ANY($2::text[])`,
    [installation.workspaceId, Object.entries(recordIds).filter(([key]) => key.startsWith('agent:')).map(([, id]) => id)]
  );
  await client.query(
    `UPDATE workflow_definitions SET
       origin=jsonb_set(origin,'{templateVersion}','2'::jsonb,true),
       capability_policy=CASE WHEN capability_policy ? 'restrictionMode' THEN capability_policy
         ELSE jsonb_set(capability_policy,'{restrictionMode}','"restrict"'::jsonb,true) END,
       updated_at=NOW()
     WHERE workspace_id=$1 AND id=ANY($2::text[])`,
    [installation.workspaceId, Object.entries(recordIds).filter(([key]) => key.startsWith('workflow:')).map(([, id]) => id)]
  );
  const upgraded = await client.query(
    `UPDATE automation_template_installations
     SET template_version=2,state='complete',installed_at=NOW()
     WHERE workspace_id=$1 AND template_id=$2 RETURNING *`,
    [installation.workspaceId, template.id]
  );
  await insertWorkspaceAuditEvent({
    workspaceId: installation.workspaceId,
    category: 'run', eventType: 'automation.template_upgraded.v2', operation: 'write',
    actorUserId: installation.installedBy, objectType: 'automation_template', objectId: template.id,
    objectName: template.name, summary: 'Starter automation upgraded',
    metadata: { templateId: template.id, fromVersion: installation.templateVersion, toVersion: 2 }
  }, client);
  return mapTemplateInstallation(upgraded.rows[0]);
}

export async function upgradeStarterAutomationV3InTransaction(
  client: PoolClient,
  installation: TemplateInstallationRecord,
  template: StarterTemplateIdentity
): Promise<TemplateInstallationRecord> {
  const recordIds = installation.recordIds || {};
  const managedWorkflowId = recordIds['workflow:managedResponse'];
  if (managedWorkflowId) {
    const agentIds = [recordIds['agent:targetDiagnostics'], recordIds['agent:incidentReporter']].filter(Boolean);
    await client.query(
      `UPDATE workflow_definitions SET name='Incident investigation',
         description='Coordinate target diagnostics and incident reporting for an exact target and selected chats.',
         prompt='Investigate the exact selected target and selected incident chats, then produce a provenance-preserving report.',
         agent_ids=$3,entry_agent_id=$4,
         capability_policy=$5,inputs=$6,target_constraints=$7,
         origin=jsonb_set(origin,'{templateVersion}','3'::jsonb,true),version=version+1,
         readiness_status='needs_setup',readiness_reasons=$8,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2`,
      [installation.workspaceId, managedWorkflowId, JSON.stringify(agentIds), agentIds[0], {
        mode: 'read_only', restrictionMode: 'restrict',
        semanticCapabilityIds: ['chat.sessions.read_selected', 'reports.pdf.generate', 'target.diagnostics.read'],
        contextGrants: ['selected_chat_sessions'], maxRuntimeSeconds: 900, retentionDays: 90,
        approvalRequirements: []
      }, JSON.stringify([
        { name: 'incidentChats', label: 'Incident chats', type: 'chat_session_list', required: true, optionSource: 'chatSessions' },
        { name: 'investigationQuestion', label: 'Investigation question', type: 'text', required: true }
      ]), JSON.stringify({ targetTypes: ['kubernetes', 'virtual_machine'], targetIds: [] }),
      JSON.stringify(['Target diagnostic mappings and selected-chat access are being recomputed.'])]
    );
  }
  const remediationWorkflowId = recordIds['workflow:targetRemediation'];
  if (remediationWorkflowId) {
    await client.query(
      `UPDATE workflow_definitions SET target_constraints=$3,inputs=$4,
         origin=jsonb_set(origin,'{templateVersion}','3'::jsonb,true),version=version+1,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2`,
      [installation.workspaceId, remediationWorkflowId,
       JSON.stringify({ targetTypes: ['kubernetes'], targetIds: [] }),
       JSON.stringify([{ name: 'requestedChange', label: 'Requested change', type: 'text', required: true }])]
    );
  }
  await client.query(
    `UPDATE agent_definitions SET origin=jsonb_set(origin,'{templateVersion}','3'::jsonb,true),updated_at=NOW()
     WHERE workspace_id=$1 AND id=ANY($2::text[])`,
    [installation.workspaceId, Object.entries(recordIds).filter(([key]) => key.startsWith('agent:')).map(([, id]) => id)]
  );
  await client.query(
    `UPDATE workflow_definitions SET origin=jsonb_set(origin,'{templateVersion}','3'::jsonb,true),updated_at=NOW()
     WHERE workspace_id=$1 AND id=ANY($2::text[])`,
    [installation.workspaceId, Object.entries(recordIds).filter(([key]) => key.startsWith('workflow:')).map(([, id]) => id)]
  );
  const upgraded = await client.query(
    `UPDATE automation_template_installations SET template_version=3,state='complete',installed_at=NOW()
     WHERE workspace_id=$1 AND template_id=$2 RETURNING *`,
    [installation.workspaceId, template.id]
  );
  await insertWorkspaceAuditEvent({
    workspaceId: installation.workspaceId,
    category: 'run', eventType: 'automation.template_upgraded.v3', operation: 'write',
    actorUserId: installation.installedBy, objectType: 'automation_template', objectId: template.id,
    objectName: template.name, summary: 'Starter automation workflows upgraded',
    metadata: { templateId: template.id, fromVersion: installation.templateVersion, toVersion: 3 }
  }, client);
  return mapTemplateInstallation(upgraded.rows[0]);
}

export async function upgradeStarterAutomationV4InTransaction(
  client: PoolClient,
  installation: TemplateInstallationRecord,
  template: StarterTemplateIdentity
): Promise<TemplateInstallationRecord> {
  const recordIds = installation.recordIds || {};
  const targetDiagnosticsWorkflowId = recordIds['workflow:targetDiagnostics'];
  let activatedTargetDiagnostics = false;

  if (targetDiagnosticsWorkflowId) {
    const updated = await client.query(
      `UPDATE workflow_definitions
       SET status='active',version=version+1,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND status='draft'
       RETURNING id`,
      [installation.workspaceId, targetDiagnosticsWorkflowId]
    );
    activatedTargetDiagnostics = Boolean(updated.rowCount);
  }

  await client.query(
    `UPDATE agent_definitions SET origin=jsonb_set(origin,'{templateVersion}','4'::jsonb,true),updated_at=NOW()
     WHERE workspace_id=$1 AND id=ANY($2::text[])`,
    [installation.workspaceId, Object.entries(recordIds).filter(([key]) => key.startsWith('agent:')).map(([, id]) => id)]
  );
  await client.query(
    `UPDATE workflow_definitions SET origin=jsonb_set(origin,'{templateVersion}','4'::jsonb,true),updated_at=NOW()
     WHERE workspace_id=$1 AND id=ANY($2::text[])`,
    [installation.workspaceId, Object.entries(recordIds).filter(([key]) => key.startsWith('workflow:')).map(([, id]) => id)]
  );
  const upgraded = await client.query(
    `UPDATE automation_template_installations SET template_version=4,state='complete',installed_at=NOW()
     WHERE workspace_id=$1 AND template_id=$2 RETURNING *`,
    [installation.workspaceId, template.id]
  );
  await insertWorkspaceAuditEvent({
    workspaceId: installation.workspaceId,
    category: 'run', eventType: 'automation.template_upgraded.v4', operation: 'write',
    actorUserId: installation.installedBy, objectType: 'automation_template', objectId: template.id,
    objectName: template.name, summary: 'Automatic starter availability upgraded',
    metadata: {
      templateId: template.id,
      fromVersion: installation.templateVersion,
      toVersion: 4,
      activatedTargetDiagnostics
    }
  }, client);
  return mapTemplateInstallation(upgraded.rows[0]);
}
