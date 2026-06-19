import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireTargetAccess } from '../auth/workspace-authorization.js';
import { config } from '../config.js';
import { targetChatActivityStreamKey } from '../services/target-chat-activity-events.js';
import { repo } from '../store/repository.js';
import { runtime } from '../store/runtime.js';
import { TargetChatActivityEvent } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';

function writeChatActivitySseEvent(res: Response, event: TargetChatActivityEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write('event: chat_activity\n');
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function parseActivityAfterId(req: AuthenticatedRequest): string | undefined {
  const after = toSingleParam(req.query.after as string | string[] | undefined);
  if (after && /^\d+$/.test(after)) return after;
  const lastEventId = req.headers['last-event-id'];
  const headerValue = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  return headerValue && /^\d+$/.test(headerValue) ? headerValue : undefined;
}

export async function getTargetChatActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }

    const windowSecondsParam = toSingleParam(req.query.windowSeconds as string | string[] | undefined);
    const requestedWindowSeconds = windowSecondsParam ? Number(windowSecondsParam) : NaN;
    const windowSeconds = Number.isFinite(requestedWindowSeconds)
      ? Math.max(60, Math.min(3600, Math.floor(requestedWindowSeconds)))
      : config.TARGET_CHAT_RECENT_ACTIVITY_WINDOW_SECONDS;
    const recentActivity = await repo.listRecentTargetChatActivity(workspaceId, access.target.id, windowSeconds);

    res.status(200).json({
      targetId: access.target.id,
      targetType: access.target.targetType,
      targetName: access.target.name,
      windowSeconds,
      generatedAt: new Date().toISOString(),
      recentActivity
    });
  } catch (err) {
    next(err);
  }
}

export async function streamTargetChatActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }

    const bufferedLiveEvents: TargetChatActivityEvent[] = [];
    let replaying = true;
    let lastReplayedId = BigInt(parseActivityAfterId(req) || '0');
    const key = targetChatActivityStreamKey(workspaceId, access.target.id);
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const listener = ({ event }: { event: TargetChatActivityEvent }) => {
      if (replaying) {
        bufferedLiveEvents.push(event);
        return;
      }
      const eventId = BigInt(event.id);
      if (eventId <= lastReplayedId) {
        return;
      }
      writeChatActivitySseEvent(res, event);
      lastReplayedId = eventId;
    };

    runtime.targetChatActivityStreams.on(key, listener);
    const cleanup = () => {
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      runtime.targetChatActivityStreams.off(key, listener);
    };
    req.on('close', cleanup);

    let existing: TargetChatActivityEvent[];
    try {
      existing = await repo.listTargetChatActivityEvents(workspaceId, access.target.id, {
        afterId: String(lastReplayedId),
        limit: 500
      });
    } catch (err) {
      cleanup();
      throw err;
    }
    if (closed) return;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    for (const event of existing) {
      const eventId = BigInt(event.id);
      if (eventId <= lastReplayedId) continue;
      writeChatActivitySseEvent(res, event);
      lastReplayedId = eventId;
    }

    replaying = false;
    for (const event of bufferedLiveEvents) {
      const eventId = BigInt(event.id);
      if (eventId <= lastReplayedId) continue;
      writeChatActivitySseEvent(res, event);
      lastReplayedId = eventId;
    }

    keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 20000);
  } catch (err) {
    next(err);
  }
}
