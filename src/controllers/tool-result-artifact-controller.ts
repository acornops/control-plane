import { NextFunction, Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { getWorkspaceAuthorization } from '../auth/workspace-authorization.js';
import {
  decodeToolResultArtifact,
  persistToolResultArtifact,
  ToolResultArtifactConflictError,
  ToolResultArtifactInvalidError,
  ToolResultArtifactTooLargeError
} from '../services/tool-result-artifacts.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import { toSingleParam } from '../utils/params.js';
import { incrementToolResultArtifactEvent, observeToolResultArtifactBytes } from '../metrics.js';

/** Persist a trusted complete tool result for a bounded retention window. */
export async function createToolResultArtifact(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    const artifact = await persistToolResultArtifact({
      runId,
      workspaceId: run.workspaceId,
      callId: req.body.callId,
      toolName: req.body.toolName,
      result: req.body.result,
      contentType: req.body.contentType,
    });
    incrementToolResultArtifactEvent('upload_success');
    observeToolResultArtifactBytes('uncompressed', artifact.uncompressedBytes);
    observeToolResultArtifactBytes('compressed', artifact.compressedBytes);
    res.status(201).json({
      id: artifact.id,
      expires_at: artifact.expiresAt,
      sha256: artifact.sha256,
      uncompressed_bytes: artifact.uncompressedBytes,
      compressed_bytes: artifact.compressedBytes,
      content_type: artifact.contentType,
    });
  } catch (err) {
    if (err instanceof ToolResultArtifactInvalidError) {
      incrementToolResultArtifactEvent('metadata_rejected');
      res.status(400).json({ error: {
        code: 'TOOL_RESULT_METADATA_INVALID', message: 'Tool result artifact metadata is invalid', retryable: false
      } });
      return;
    }
    if (err instanceof ToolResultArtifactTooLargeError) {
      incrementToolResultArtifactEvent('size_rejected');
      res.status(413).json({ error: {
        code: 'TOOL_RESULT_TOO_LARGE', message: 'Tool result exceeds the artifact size limit', retryable: false
      } });
      return;
    }
    if (err instanceof ToolResultArtifactConflictError) {
      incrementToolResultArtifactEvent('call_conflict');
      res.status(409).json({ error: {
        code: 'TOOL_RESULT_CALL_CONFLICT', message: 'Tool call already has a different artifact', retryable: false
      } });
      return;
    }
    incrementToolResultArtifactEvent('storage_failure');
    next(err);
  }
}

/** Return a complete redacted tool artifact to an authorized workspace reader. */
export async function getToolResultArtifact(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const runId = toSingleParam(req.params.runId);
    const artifactId = toSingleParam(req.params.artifactId);
    const run = await repo.getRun(runId);
    const authz = run ? await getWorkspaceAuthorization(req, run.workspaceId) : null;
    if (!run || !authz?.can('read_workspace_data')) {
      incrementToolResultArtifactEvent('authorization_denied');
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool result artifact not found', retryable: false } });
      return;
    }
    const artifact = await repo.getToolResultArtifact(runId, artifactId);
    if (!artifact || artifact.workspaceId !== run.workspaceId) {
      incrementToolResultArtifactEvent('unavailable');
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool result artifact not found', retryable: false } });
      return;
    }
    const body = await decodeToolResultArtifact(
      artifact.payload, artifact.sha256, artifact.uncompressedBytes
    );
    await recordWorkspaceAuditEvent({
      workspaceId: run.workspaceId,
      category: 'tool',
      eventType: 'tool.result.read.v1',
      operation: 'read',
      actorUserId: req.auth.userId,
      objectType: 'tool_result_artifact',
      objectId: artifact.id,
      objectName: artifact.toolName,
      summary: 'Full redacted tool result viewed',
      metadata: { runId, callId: artifact.callId, sha256: artifact.sha256 },
    });
    incrementToolResultArtifactEvent('download_success');
    res.setHeader('Content-Type', artifact.contentType);
    const filename = `${artifact.toolName}-${artifact.callId}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
    const extension = artifact.contentType === 'text/plain' ? 'txt' : 'json';
    res.setHeader('Content-Disposition', `inline; filename="${filename}.${extension}"`);
    res.status(200).send(body);
  } catch (err) {
    incrementToolResultArtifactEvent('download_failure');
    next(err);
  }
}
