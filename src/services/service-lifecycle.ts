import { AsyncLocalStorage } from 'node:async_hooks';
import type { ErrorRequestHandler, Express, NextFunction, Request, RequestHandler, Response } from 'express';

const requestSignals = new AsyncLocalStorage<AbortSignal>();
export function currentRequestSignal(): AbortSignal | undefined { return requestSignals.getStore(); }

/** Owns dependency users, including handlers whose HTTP clients have disconnected. */
export class ServiceLifecycle {
  private active = 0;
  private deadline?: number;
  private stopping = false;
  private readonly drainObservers = new Set<() => void>();
  get accepting(): boolean { return this.deadline === undefined; }
  get drainDeadline(): number { return this.deadline ?? Infinity; }
  get isStopping(): boolean { return this.stopping; }

  beginDrain(timeoutMs: number): number {
    if (this.deadline === undefined) {
      this.deadline = performance.now() + timeoutMs;
      for (const observer of [...this.drainObservers]) observer();
    }
    return this.deadline;
  }

  onDrain(observer: () => void): () => void {
    if (!this.accepting) observer();
    else this.drainObservers.add(observer);
    return () => { this.drainObservers.delete(observer); };
  }

  beginStopping(): void { this.stopping = true; }

  retain(): () => void {
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }

  async track<T>(work: () => T | PromiseLike<T>): Promise<T> {
    const release = this.retain();
    try { return await work(); } finally { release(); }
  }

  interval(work: () => void | Promise<void>, milliseconds: number): NodeJS.Timeout {
    return setInterval(() => {
      if (this.accepting) void this.track(work);
    }, milliseconds);
  }

  async waitForIdle(deadline: number): Promise<boolean> {
    while (this.active > 0) {
      if (performance.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now()))));
    }
    return true;
  }

  readonly admission: RequestHandler = (req, res, next) => {
    if (req.path === '/health' || req.path === '/ready' || req.path === '/metrics') {
      next();
      return;
    }
    if (!this.accepting) {
      res.setHeader('Retry-After', '1');
      res.setHeader('Connection', 'close');
      res.status(503).json({ error: {
        code: 'SERVICE_DRAINING', message: 'Service is draining', retryable: true, outcome: 'not_started'
      } });
      return;
    }
    const release = this.retain();
    res.once('finish', release);
    res.once('close', release);
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    requestSignals.run(controller.signal, next);
  };
}

type ParameterHandler = (req: Request, res: Response, next: NextFunction, value: string, name: string) => unknown;
interface TrackedRouter { stack?: HandlerLayer[]; params?: Record<string, ParameterHandler[]> }
interface HandlerLayer {
  handle: RequestHandler & TrackedRouter;
  route?: { stack: HandlerLayer[] };
}
const wrapped = new WeakSet<object>();

/** Express 5's router stack is traversed only at assembly, preserving handler arity. */
export function installHandlerTracking(app: Express, lifecycle: ServiceLifecycle): void {
  function visitRouter(router: TrackedRouter): void {
    for (const handlers of Object.values(router.params || {})) {
      if (wrapped.has(handlers)) continue;
      wrapped.add(handlers);
      for (let index = 0; index < handlers.length; index++) {
        const handler = handlers[index];
        handlers[index] = (req, res, next, value, name) => lifecycle.track(() => handler(req, res, next, value, name));
      }
    }
    visit(router.stack || []);
  }
  function visit(layers: HandlerLayer[]): void {
    for (const layer of layers) {
      if (layer.route) { visit(layer.route.stack); continue; }
      if (layer.handle.stack) { visitRouter(layer.handle); continue; }
      if (wrapped.has(layer)) continue;
      wrapped.add(layer);
      const handler = layer.handle;
      if (handler.length > 4) continue;
      if (handler.length === 4) {
        const errorHandler = handler as unknown as ErrorRequestHandler;
        layer.handle = function(error: unknown, req: Request, res: Response, next: NextFunction) {
          return lifecycle.track(() => errorHandler(error, req, res, next));
        } as unknown as RequestHandler;
        continue;
      }
      layer.handle = function(req: Request, res: Response, next: NextFunction) {
        const release = lifecycle.retain();
        try {
          const result: unknown = handler(req, res, next);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            return Promise.resolve(result).finally(release);
          }
          release();
          return result;
        } catch (error) { release(); throw error; }
      };
    }
  }
  visitRouter(app.router as TrackedRouter);
}

export const serviceLifecycle = new ServiceLifecycle();
