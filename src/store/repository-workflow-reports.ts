import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { observeAutomationPdfRender } from '../metrics.js';

export class WorkflowReportError extends Error {
  constructor(readonly code: 'REPORT_SOURCE_TOO_LARGE' | 'REPORT_RENDER_TIMEOUT' | 'REPORT_PDF_TOO_LARGE') {
    super(code);
    this.name = 'WorkflowReportError';
  }
}

export interface WorkflowReportRecord {
  id: string; workspaceId: string; executionId?: string; runId?: string; targetRunId?: string;
  toolCallId?: string;
  sourceVersion: number; mediaType: string; title: string;
  source: Record<string, unknown>; provenance: Record<string, unknown>;
  sourceSizeBytes: number; retentionExpiresAt: string; createdAt: string;
}

type Row = QueryResultRow;
const map = (row: Row): WorkflowReportRecord => ({
  id: row.id, workspaceId: row.workspace_id,
  executionId: row.execution_id || undefined, runId: row.run_id || undefined,
  targetRunId: row.target_run_id || undefined,
  toolCallId: row.tool_call_id || undefined,
  sourceVersion: row.source_version, mediaType: row.media_type, title: row.title,
  source: row.source, provenance: row.provenance, sourceSizeBytes: row.source_size_bytes,
  retentionExpiresAt: new Date(row.retention_expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString()
});

export async function createWorkflowReport(input: {
  workspaceId: string; executionId: string; runId: string; title: string;
  source: Record<string, unknown>; provenance: Record<string, unknown>; retentionDays: number;
  toolCallId: string;
}): Promise<WorkflowReportRecord> {
  const sourceSize = Buffer.byteLength(JSON.stringify(input.source), 'utf8');
  if (sourceSize > config.REPORT_SOURCE_MAX_BYTES) throw new WorkflowReportError('REPORT_SOURCE_TOO_LARGE');
  const candidate: WorkflowReportRecord = {
    id: randomUUID(), workspaceId: input.workspaceId, executionId: input.executionId, runId: input.runId,
    toolCallId: input.toolCallId, sourceVersion: 1, mediaType: 'application/pdf', title: input.title,
    source: input.source, provenance: input.provenance, sourceSizeBytes: sourceSize,
    retentionExpiresAt: new Date(Date.now() + input.retentionDays * 86_400_000).toISOString(),
    createdAt: new Date().toISOString()
  };
  const renderStartedAt = Date.now();
  try {
    const bytes = renderWorkflowReportPdf(candidate);
    observeAutomationPdfRender('success', Date.now() - renderStartedAt, bytes.length);
  } catch (error) {
    observeAutomationPdfRender('error', Date.now() - renderStartedAt);
    throw error;
  }
  const result = await db.query<Row>(
    `INSERT INTO workflow_reports (
      id,workspace_id,execution_id,run_id,tool_call_id,source_version,media_type,title,source,provenance,source_size_bytes,retention_expires_at
     ) VALUES ($1,$2,$3,$4,$5,1,'application/pdf',$6,$7,$8,$9,NOW()+($10::text||' days')::interval)
     ON CONFLICT (run_id,tool_call_id) WHERE tool_call_id IS NOT NULL
     DO UPDATE SET tool_call_id=EXCLUDED.tool_call_id RETURNING *`,
    [candidate.id, input.workspaceId, input.executionId, input.runId, input.toolCallId, input.title, input.source,
     input.provenance, sourceSize, input.retentionDays]
  );
  return map(result.rows[0]);
}

export async function createTargetRunReport(input: {
  workspaceId: string; targetRunId: string; title: string;
  source: Record<string, unknown>; provenance: Record<string, unknown>; retentionDays: number;
  toolCallId: string;
}): Promise<WorkflowReportRecord> {
  const sourceSize = Buffer.byteLength(JSON.stringify(input.source), 'utf8');
  if (sourceSize > config.REPORT_SOURCE_MAX_BYTES) throw new WorkflowReportError('REPORT_SOURCE_TOO_LARGE');
  const candidate: WorkflowReportRecord = {
    id: randomUUID(), workspaceId: input.workspaceId, targetRunId: input.targetRunId,
    toolCallId: input.toolCallId, sourceVersion: 1, mediaType: 'application/pdf', title: input.title,
    source: input.source, provenance: input.provenance, sourceSizeBytes: sourceSize,
    retentionExpiresAt: new Date(Date.now() + input.retentionDays * 86_400_000).toISOString(),
    createdAt: new Date().toISOString()
  };
  const renderStartedAt = Date.now();
  try {
    const bytes = renderWorkflowReportPdf(candidate);
    observeAutomationPdfRender('success', Date.now() - renderStartedAt, bytes.length);
  } catch (error) {
    observeAutomationPdfRender('error', Date.now() - renderStartedAt);
    throw error;
  }
  const result = await db.query<Row>(
    `INSERT INTO workflow_reports (
      id,workspace_id,execution_id,run_id,target_run_id,tool_call_id,source_version,media_type,title,source,provenance,source_size_bytes,retention_expires_at
     ) VALUES ($1,$2,NULL,NULL,$3,$4,1,'application/pdf',$5,$6,$7,$8,NOW()+($9::text||' days')::interval)
     ON CONFLICT (target_run_id,tool_call_id) WHERE target_run_id IS NOT NULL AND tool_call_id IS NOT NULL
     DO UPDATE SET tool_call_id=EXCLUDED.tool_call_id RETURNING *`,
    [candidate.id, input.workspaceId, input.targetRunId, input.toolCallId, input.title, input.source,
     input.provenance, sourceSize, input.retentionDays]
  );
  return map(result.rows[0]);
}

export async function getWorkflowReport(id: string): Promise<WorkflowReportRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_reports WHERE id=$1 AND retention_expires_at>NOW()', [id]);
  return result.rowCount ? map(result.rows[0]) : null;
}

function pdfEscape(value: string): string {
  const ascii = value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7e]/g, '?');
  return ascii.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function reportTextLines(report: WorkflowReportRecord): string[] {
  const text = String(report.source.markdown || report.source.content || JSON.stringify(report.source)).slice(0, 100000);
  const sourceLines = [report.title, '', ...text.replace(/\r\n?/g, '\n').split('\n')];
  return sourceLines.flatMap((line) => {
    if (!line) return [''];
    const chunks = line.match(/.{1,90}/g);
    return chunks?.length ? chunks : [''];
  });
}

export function renderWorkflowReportPdf(report: WorkflowReportRecord): Buffer {
  const started = Date.now();
  const lines = reportTextLines(report).slice(0, 300);
  const pageLines = Array.from(
    { length: Math.max(1, Math.ceil(lines.length / 48)) },
    (_, index) => lines.slice(index * 48, (index + 1) * 48)
  );
  const fontObjectId = 3 + pageLines.length * 2;
  const pageObjectIds = pageLines.map((_, index) => 3 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageLines.length} >>`
  ];
  pageLines.forEach((page, index) => {
    const pageObjectId = pageObjectIds[index];
    const contentObjectId = pageObjectId + 1;
    const stream = ['BT', '/F1 10 Tf', '48 760 Td', ...page.flatMap((line, lineIndex) => [
      lineIndex ? '0 -14 Td' : '', `(${pdfEscape(line)}) Tj`
    ]).filter(Boolean), 'ET'].join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`
    );
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = Buffer.from(pdf, 'utf8');
  if (Date.now() - started > config.REPORT_RENDER_TIMEOUT_MS) throw new WorkflowReportError('REPORT_RENDER_TIMEOUT');
  if (bytes.length > config.REPORT_PDF_MAX_BYTES) throw new WorkflowReportError('REPORT_PDF_TOO_LARGE');
  return bytes;
}
