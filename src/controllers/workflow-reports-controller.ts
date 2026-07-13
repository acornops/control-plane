import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { observeAutomationPdfRender } from '../metrics.js';
import { getWorkflowReport, renderWorkflowReportPdf } from '../store/repository-workflow-reports.js';
import { toSingleParam } from '../utils/params.js';

export async function getWorkflowReportMetadata(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const report = await getWorkflowReport(toSingleParam(req.params.reportId));
    if (!report) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found', retryable: false } }); return; }
    if (!(await requireWorkspaceDataRead(req, res, report.workspaceId, 'No access to report'))) return;
    const { source: _source, provenance: _provenance, ...metadata } = report;
    res.status(200).json({ report: metadata });
  } catch (err) { next(err); }
}

export async function downloadWorkflowReport(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const startedAt = Date.now();
  try {
    const report = await getWorkflowReport(toSingleParam(req.params.reportId));
    if (!report) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found', retryable: false } }); return; }
    if (!(await requireWorkspaceDataRead(req, res, report.workspaceId, 'No access to report'))) return;
    const bytes = renderWorkflowReportPdf(report);
    observeAutomationPdfRender('success', Date.now() - startedAt, bytes.length);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="incident-report-${report.id}.pdf"`);
    res.status(200).send(bytes);
  } catch (err) {
    observeAutomationPdfRender('error', Date.now() - startedAt);
    next(err);
  }
}
