import { type NextFunction, type Response } from 'express';
import { requireWorkspaceCapability } from '../auth/workspace-authorization.js';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { LlmGatewayHttpError, updateWorkspaceTool } from '../services/mcp-registry-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { listWorkflowMcpServers } from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

export async function updateWorkflowMcpToolForWorkspace(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const serverId = toSingleParam(req.params.serverId);
    const toolName = toSingleParam(req.params.toolName);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_mcp', 'No permission to manage MCP servers');
    if (!authz) return;
    const server = (await listWorkflowMcpServers(workspaceId)).find((item) => item.id === serverId);
    const tool = server?.tools.find((item) => item.name === toolName);
    if (!server || !tool) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'MCP server or tool not found', retryable: false } });
      return;
    }
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : tool.enabled;
    const requestedCapability = req.body?.capability;
    const capability = requestedCapability === 'read' || requestedCapability === 'write' ? requestedCapability : tool.capability;
    if (enabled && !tool.enabled && requestedCapability !== 'read' && requestedCapability !== 'write') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'capability is required when enabling a discovered MCP tool', retryable: false } });
      return;
    }
    const updated = await updateWorkspaceTool(workspaceId, toolName, { enabled, capability });
    await recordWorkspaceAuditEvent({
      workspaceId, category: 'mcp', eventType: 'workspace.mcp_tool_updated.v1', operation: 'write',
      actorUserId: req.auth.userId, objectType: 'mcp_tool', objectId: toolName, objectName: toolName,
      summary: 'Workspace MCP tool updated', metadata: { serverId, enabled, capability }
    });
    res.status(200).json({ tool: updated });
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: 'Workspace MCP service is unavailable' });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
