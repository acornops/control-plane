import { serviceLifecycle } from './service-lifecycle.js';
import type { Request, Response } from 'express';
import { assertActiveWorkspace } from './workspace-execution-access.js';

/** Watches replayable observers; call the returned function after replay and cleanup registration. */
export function watchWorkspaceStream(req: Request, res: Response, workspaceId: string): () => void {
  let checking = false;
  let replayFinished = false;
  const endObserver = () => {
    if (replayFinished && !res.writableEnded && !res.destroyed) res.end();
  };
  const stopDrainObserver = serviceLifecycle.onDrain(endObserver);
  const timer = setInterval(() => {
    if (serviceLifecycle.isStopping) return;
    void serviceLifecycle.track(async () => {
      if (checking || res.writableEnded) return;
      checking = true;
      try { await assertActiveWorkspace(workspaceId); }
      catch {
        if (res.writableEnded || res.destroyed) return;
        res.write('event: workspace_suspended\ndata: {"code":"WORKSPACE_SUSPENDED"}\n\n');
        res.end();
        clearInterval(timer);
      } finally { checking = false; }
    });
  }, 1000);
  timer.unref();
  const cleanup = () => { clearInterval(timer); stopDrainObserver(); };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return () => {
    replayFinished = true;
    if (!serviceLifecycle.accepting) endObserver();
  };
}
