import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { observeAutomationPdfRender } from '../metrics.js';
import {
  getGeneratedDocument,
  renderGeneratedDocumentPdf,
  type GeneratedDocumentRecord
} from '../store/repository-generated-documents.js';
import { toSingleParam } from '../utils/params.js';
import { getWorkflowExecution } from '../store/repository-workflows.js';
import { externalIntegrationOwnsWorkflowExecution } from './workflow-execution-access.js';

async function canReadDocument(req: AuthenticatedRequest, res: Response, document: { workspaceId: string; workflowExecutionId?: string }): Promise<boolean> {
  if (!(await requireWorkspaceDataRead(req, res, document.workspaceId, 'No access to document'))) return false;
  if (req.auth.credential.type !== 'external_integration') return true;
  const execution = document.workflowExecutionId
    ? await getWorkflowExecution(document.workflowExecutionId)
    : null;
  if (execution && externalIntegrationOwnsWorkflowExecution(req, execution)) return true;
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found', retryable: false } });
  return false;
}

function publicDocument(document: GeneratedDocumentRecord) {
  const { source: _source, provenance: _provenance, ...metadata } = document;
  return {
    ...metadata,
    downloadUrl: `/api/v1/report-artifacts/${encodeURIComponent(document.id)}/download`
  };
}

export async function getGeneratedDocumentMetadata(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const document = await getGeneratedDocument(toSingleParam(req.params.reportId));
    if (!document) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found', retryable: false } }); return; }
    if (!(await canReadDocument(req, res, document))) return;
    res.status(200).json({ report: publicDocument(document) });
  } catch (err) { next(err); }
}

export async function downloadGeneratedDocument(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  let isPdf = false;
  try {
    const document = await getGeneratedDocument(toSingleParam(req.params.reportId));
    if (!document) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found', retryable: false } }); return; }
    if (!(await canReadDocument(req, res, document))) return;
    isPdf = document.mediaType === 'application/pdf';
    const bytes = isPdf
      ? renderGeneratedDocumentPdf(document)
      : Buffer.from(String(document.source.markdown || ''), 'utf8');
    if (isPdf) observeAutomationPdfRender('success', Date.now() - startedAt, bytes.length);
    res.setHeader('Content-Type', document.mediaType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="document-${document.id}.${isPdf ? 'pdf' : 'md'}"`);
    res.status(200).send(bytes);
  } catch (err) {
    if (isPdf) observeAutomationPdfRender('error', Date.now() - startedAt);
    next(err);
  }
}
