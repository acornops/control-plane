import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { observeAutomationPdfRender } from '../metrics.js';
import {
  getWorkflowReport,
  renderWorkflowReportPdf,
  type WorkflowReportRecord
} from '../store/repository-workflow-reports.js';
import { toSingleParam } from '../utils/params.js';
import { getWorkflowExecution } from '../store/repository-workflows.js';
import { externalIntegrationOwnsWorkflowExecution } from './workflow-execution-access.js';

async function canReadReport(req: AuthenticatedRequest, res: Response, report: { workspaceId: string; executionId: string }): Promise<boolean> {
  if (!(await requireWorkspaceDataRead(req, res, report.workspaceId, 'No access to report'))) return false;
  if (req.auth.credential.type !== 'external_integration') return true;
  const execution = await getWorkflowExecution(report.executionId);
  if (execution && externalIntegrationOwnsWorkflowExecution(req, execution)) return true;
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found', retryable: false } });
  return false;
}

function publicReport(report: WorkflowReportRecord) {
  const { source: _source, provenance: _provenance, ...metadata } = report;
  return {
    ...metadata,
    downloadUrl: `/api/v1/report-artifacts/${encodeURIComponent(report.id)}/download`
  };
}

export async function getWorkflowReportMetadata(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const report = await getWorkflowReport(toSingleParam(req.params.reportId));
    if (!report) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found', retryable: false } }); return; }
    if (!(await requireWorkspaceDataRead(req, res, report.workspaceId, 'No access to report'))) return;
    res.status(200).json({ report: publicReport(report) });
  } catch (err) { next(err); }
}

export async function downloadWorkflowReport(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  try {
    const report = await getWorkflowReport(toSingleParam(req.params.reportId));
    if (!report) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found', retryable: false } }); return; }
    if (!(await canReadReport(req, res, report))) return;
    const bytes = renderWorkflowReportPdf(report);
    observeAutomationPdfRender('success', Date.now() - startedAt, bytes.length);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="report-artifact-${report.id}.pdf"`);
    res.status(200).send(bytes);
  } catch (err) {
    observeAutomationPdfRender('error', Date.now() - startedAt);
    next(err);
  }
}
