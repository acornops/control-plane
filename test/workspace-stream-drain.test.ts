import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../src/infra/db.js';
import { serviceLifecycle } from '../src/services/service-lifecycle.js';
import { watchWorkspaceStream } from '../src/services/workspace-stream-lifecycle.js';

test('a stream close retains an already-running workspace authorization callback', async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mock.method(db, 'query', async () => { started(); await gate; return { rows: [{ lifecycle_status: 'active' }] }; });
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { writableEnded: false, write() {}, end() {} });
  watchWorkspaceStream(req as Request, res as unknown as Response, 'workspace');
  await began;
  res.emit('close');
  try { assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 20), false); }
  finally { release(); mock.restoreAll(); }
  assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 100), true);
});

test('drain ends a replayable observer cleanly while retaining its running authorization check', async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mock.method(db, 'query', async () => { started(); await gate; return { rowCount: 1, rows: [{ lifecycle_status: 'active' }] }; });
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, write() {}, end() { this.writableEnded = true; this.emit('finish'); this.emit('close'); }
  });
  const replayFinished = watchWorkspaceStream(req as Request, res as unknown as Response, 'workspace');
  await began;
  serviceLifecycle.beginDrain(1000);
  try {
    assert.equal(res.writableEnded, false, 'accepted replay must finish before observer shutdown');
    replayFinished();
    assert.equal(res.writableEnded, true);
    assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 20), false);
  } finally {
    res.emit('close');
    release();
    mock.restoreAll();
  }
  assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 100), true);
});
