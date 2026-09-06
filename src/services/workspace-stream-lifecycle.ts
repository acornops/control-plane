import type { Request, Response } from 'express';
import { assertActiveWorkspace } from './workspace-execution-access.js';

/** Existing streams close within one second of observed suspension, including after missed notifications. */
export function watchWorkspaceStream(req: Request, res: Response, workspaceId: string): void {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || res.writableEnded) return;
    checking = true;
    try { await assertActiveWorkspace(workspaceId); }
    catch {
      res.write('event: workspace_suspended\ndata: {"code":"WORKSPACE_SUSPENDED"}\n\n');
      res.end();
      clearInterval(timer);
    } finally { checking = false; }
  }, 1000);
  timer.unref();
  req.on('close', () => clearInterval(timer));
  res.on('close', () => clearInterval(timer));
}
