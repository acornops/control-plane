import type { WorkflowDefinitionForAccess } from '../types/workflows.js';

export function defaultWorkflowDefinitions(workspaceId: string): WorkflowDefinitionForAccess[] {
  return [
    {
      id: 'cluster-triage',
      workspaceId,
      version: 1,
      source: 'system',
      templateId: 'cluster-triage',
      name: 'Cluster triage',
      description: 'Inspect a selected cluster and summarize likely causes, severity, and next actions.',
      status: 'active',
      category: 'cluster-triage',
      tags: ['cluster', 'triage', 'incident'],
      enabledMcpServers: ['acornops-cluster-agent'],
      enabledSkills: ['acornops-observability', 'acornops-target-boundary-design'],
      inputs: [],
      requiredPermissions: ['read_workspace_data', 'create_read_only_runs'],
      policy: {
        mode: 'read_only',
        maxRuntimeSeconds: 900,
        retentionDays: 90,
        approvalRequirements: []
      },
      steps: [
        {
          id: 'collect-cluster-signals',
          title: 'Collect cluster signals',
          requiredInputs: [],
          targetBinding: { type: 'selected_cluster', targetType: 'kubernetes', inputName: 'clusterId' },
          enabledSkills: ['acornops-observability', 'acornops-target-boundary-design'],
          allowedMcpServers: ['acornops-cluster-agent'],
          allowedTools: ['inventory.resources.list', 'events.search', 'logs.summarize', 'metrics.query'],
          contextGrants: ['workspace_metadata', 'target_inventory'],
          approvalRequired: false
        }
      ],
      starterPrompt: 'Triage the selected cluster. Start by showing the compiled read scope.'
    },
    {
      id: 'repository-operation',
      workspaceId,
      version: 1,
      source: 'system',
      templateId: 'repository-operation',
      name: 'Repository operation',
      description: 'Prepare and apply a controlled configuration change in a selected repository.',
      status: 'active',
      category: 'git-operations',
      tags: ['git', 'repository', 'operations'],
      enabledMcpServers: ['github'],
      enabledSkills: ['acornops-cross-repo-change', 'acornops-open-pr'],
      inputs: [],
      requiredPermissions: ['read_workspace_data', 'create_read_write_runs'],
      policy: {
        mode: 'read_write',
        maxRuntimeSeconds: 1200,
        retentionDays: 90,
        approvalRequirements: ['Before creating branches or pull requests']
      },
      steps: [
        {
          id: 'inspect-repository-state',
          title: 'Inspect repository state',
          requiredInputs: [],
          enabledSkills: ['acornops-cross-repo-change'],
          allowedMcpServers: ['github'],
          allowedTools: ['github.repositories.read', 'github.branches.list', 'github.prs.list'],
          contextGrants: ['workspace_metadata'],
          approvalRequired: false
        },
        {
          id: 'prepare-git-change',
          title: 'Prepare Git change',
          requiredInputs: [],
          enabledSkills: ['acornops-open-pr'],
          allowedMcpServers: ['github'],
          allowedTools: ['github.branches.create', 'github.prs.create'],
          contextGrants: ['workspace_metadata'],
          approvalRequired: true,
          outputArtifacts: [{ id: 'patch-plan', type: 'patch', title: 'Repository change plan', required: true }]
        }
      ],
      starterPrompt: 'Prepare the selected repository operation and ask for approval before writing.'
    },
    {
      id: 'incident-report-pdf',
      workspaceId,
      version: 1,
      source: 'system',
      templateId: 'incident-report-pdf',
      name: 'Generate incident report from chats',
      description: 'Read selected cluster chats and generate a PDF incident report artifact.',
      status: 'active',
      category: 'incident-review',
      tags: ['incident', 'report', 'pdf'],
      enabledMcpServers: ['workspace-chat', 'artifact-writer'],
      enabledSkills: ['acornops-observability'],
      inputs: [],
      requiredPermissions: ['read_workspace_data', 'create_read_only_runs'],
      policy: {
        mode: 'read_only',
        maxRuntimeSeconds: 1500,
        retentionDays: 180,
        approvalRequirements: ['Before reading selected chats']
      },
      steps: [
        {
          id: 'generate-incident-report',
          title: 'Generate incident report',
          requiredInputs: [],
          enabledSkills: ['acornops-observability'],
          allowedMcpServers: ['workspace-chat', 'artifact-writer'],
          allowedTools: ['chat.sessions.read_selected', 'reports.pdf.generate'],
          contextGrants: ['selected_chat_sessions'],
          approvalRequired: true,
          outputArtifacts: [{ id: 'incident-report', type: 'pdf', title: 'Incident report PDF', required: true }]
        }
      ],
      starterPrompt: 'Generate a PDF incident report from the selected chats.'
    }
  ];
}


