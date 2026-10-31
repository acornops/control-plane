import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import WebSocket from 'ws';

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(20); }
  throw new Error('Timed out waiting for subprocess condition');
}

async function processDrainCase(expire: boolean, tls = false): Promise<void> {
  assert.ok(process.env.CONTROL_PLANE_TEST_DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, process.env.CONTROL_PLANE_TEST_DATABASE_URL);
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /test/);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const tlsDirectory = mkdtempSync(join(tmpdir(), 'cp-drain-tls-'));
  const certFile = join(tlsDirectory, 'cert.pem');
  const keyFile = join(tlsDirectory, 'key.pem');
  const internalReservation = createServer();
  await new Promise<void>((resolve) => internalReservation.listen(0, '127.0.0.1', resolve));
  const internalPort = (internalReservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => internalReservation.close(() => resolve()));
  if (tls) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile,
    '-out', certFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const internalRequest = (path: string, init: RequestInit): Promise<Response> => {
    if (!tls) return fetch(`http://127.0.0.1:${port}${path}`, init);
    return new Promise((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: internalPort, path, method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)), ca: readFileSync(certFile),
        cert: readFileSync(certFile), key: readFileSync(keyFile) }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += String(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve(new Response(body, { status: res.statusCode })));
      });
      req.on('error', reject);
      req.end(init.body);
    });
  };
  const application = `cp-drain-process-${process.pid}`;
  const database = new URL(process.env.DATABASE_URL!);
  database.searchParams.set('application_name', application);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: database.toString(),
      SERVICE_DRAIN_TIMEOUT_SECONDS: expire ? '1' : '3', WORKSPACE_ADMISSION_ENABLED: 'false', WORKSPACE_DISPATCH_ENABLED: 'false',
      SEED_DEVELOPMENT_DATA: 'false', INTERNAL_TRANSPORT_TLS_ENABLED: String(tls),
      ...(tls ? { INTERNAL_TRANSPORT_TLS_CERT_FILE: certFile, INTERNAL_TRANSPORT_TLS_KEY_FILE: keyFile,
        INTERNAL_TRANSPORT_TLS_CA_FILE: certFile, INTERNAL_TRANSPORT_TLS_REQUIRE_CLIENT_CERT: 'true',
        CONTROL_PLANE_INTERNAL_TRANSPORT_PORT: String(internalPort), EXECUTION_ENGINE_BASE_URL: 'https://127.0.0.1:9',
        LLM_GATEWAY_URL: 'https://127.0.0.1:9', BUILTIN_TARGET_MCP_SERVER_URL: `https://127.0.0.1:${internalPort}/internal/v1/mcp` } : {}),
      CONTROL_PLANE_INSTANCE_ID: application }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const lock = await db.connect();
  let socket: WebSocket | undefined;
  try {
    await waitUntil(() => output.includes('AcornOps control plane started') || child.exitCode !== null);
    assert.equal(child.exitCode, null, output);
    if (tls) await waitUntil(() => output.includes('control plane internal transport started'));
    socket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/connect`);
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
    const socketClosed = new Promise<void>((resolve) => socket!.once('close', () => resolve()));
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE runs IN ACCESS EXCLUSIVE MODE');
    const accepted = internalRequest('/internal/v1/runs/cancellation-status', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ORCH_SERVICE_TOKEN || 'dev_orchestrator_token'}` },
      body: JSON.stringify({ runIds: ['absent'] })
    }).catch((error: unknown) => error);
    await waitUntil(async () => (await db.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1
      AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM runs WHERE id%'`, [application])).rowCount! > 0);
    child.kill('SIGTERM');
    await waitUntil(() => output.includes('Shutting down control plane'));
    child.kill('SIGTERM');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status, 503);
    const rejected = await internalRequest('/internal/v1/runs/cancellation-status', { method: 'POST' });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.outcome, 'not_started');
    assert.equal(child.exitCode, null);
    if (expire) await delay(1200);
    await lock.query('ROLLBACK');
    const result = await accepted;
    if (!expire) { assert.ok(result instanceof Response); assert.equal(result.status, 200); }
    await socketClosed;
    assert.equal(await exited, expire ? 1 : 0, output);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    socket?.terminate();
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await db.end();
    rmSync(tlsDirectory, { recursive: true, force: true });
  }

}

test('real SIGTERM preserves a blocked accepted handler, rejects new work and closes preauth sockets', { timeout: 30_000 }, () => processDrainCase(false));
test('real SIGTERM exits unsuccessfully when accepted work exceeds its fixed drain deadline', { timeout: 30_000 }, () => processDrainCase(true));

test('real SIGTERM preserves accepted requests on the mTLS internal listener', { timeout: 30_000 }, () => processDrainCase(false, true));
