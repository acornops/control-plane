import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';

export interface WorkflowReportRecord {
  id: string; workspaceId: string; executionId: string; runId: string;
  sourceVersion: number; mediaType: string; title: string;
  source: Record<string, unknown>; provenance: Record<string, unknown>;
  sourceSizeBytes: number; retentionExpiresAt: string; createdAt: string;
}

type Row = QueryResultRow;
const map = (row: Row): WorkflowReportRecord => ({
  id: row.id, workspaceId: row.workspace_id, executionId: row.execution_id, runId: row.run_id,
  sourceVersion: row.source_version, mediaType: row.media_type, title: row.title,
  source: row.source, provenance: row.provenance, sourceSizeBytes: row.source_size_bytes,
  retentionExpiresAt: new Date(row.retention_expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString()
});

export async function createWorkflowReport(input: {
  workspaceId: string; executionId: string; runId: string; title: string;
  source: Record<string, unknown>; provenance: Record<string, unknown>; retentionDays: number;
}): Promise<WorkflowReportRecord> {
  const sourceSize = Buffer.byteLength(JSON.stringify(input.source), 'utf8');
  if (sourceSize > config.REPORT_SOURCE_MAX_BYTES) throw new Error('REPORT_SOURCE_TOO_LARGE');
  const result = await db.query<Row>(
    `INSERT INTO workflow_reports (
      id,workspace_id,execution_id,run_id,source_version,media_type,title,source,provenance,source_size_bytes,retention_expires_at
     ) VALUES ($1,$2,$3,$4,1,'application/pdf',$5,$6,$7,$8,NOW()+($9::text||' days')::interval) RETURNING *`,
    [randomUUID(), input.workspaceId, input.executionId, input.runId, input.title, input.source,
     input.provenance, sourceSize, input.retentionDays]
  );
  return map(result.rows[0]);
}

export async function getWorkflowReport(id: string): Promise<WorkflowReportRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_reports WHERE id=$1 AND retention_expires_at>NOW()', [id]);
  return result.rowCount ? map(result.rows[0]) : null;
}

function pdfEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)').replace(/[\r\n]+/g, ' ');
}

export function renderWorkflowReportPdf(report: WorkflowReportRecord): Buffer {
  const started = Date.now();
  const text = String(report.source.markdown || report.source.content || JSON.stringify(report.source)).slice(0, 100000);
  const lines = [report.title, ...(text.match(/.{1,90}/g) || [])].slice(0, 300);
  const stream = ['BT', '/F1 10 Tf', '48 760 Td', ...lines.flatMap((line, index) => [
    index ? '0 -14 Td' : '', `(${pdfEscape(line)}) Tj`
  ]).filter(Boolean), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = Buffer.from(pdf, 'utf8');
  if (Date.now() - started > config.REPORT_RENDER_TIMEOUT_MS) throw new Error('REPORT_RENDER_TIMEOUT');
  if (bytes.length > config.REPORT_PDF_MAX_BYTES) throw new Error('REPORT_PDF_TOO_LARGE');
  return bytes;
}
