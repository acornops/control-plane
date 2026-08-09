import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';
import { parseAgentVEnrollmentToken } from '../services/agentv-enrollment.js';
import { repo } from '../store/repository.js';
import { exchangeAgentVEnrollmentSchema } from '../types/contracts.js';

const WINDOW_SECONDS = 60;
const MAX_ENROLLMENT_ATTEMPTS = 10;
const MAX_ENROLLMENT_IP_ATTEMPTS = 120;
const MAX_TRANSACTION_ATTEMPTS = 180;
const MAX_TRANSACTION_IP_ATTEMPTS = 1_800;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function secureRequest(req: Request): boolean {
  if (config.NODE_ENV !== 'production') return true;
  // Express derives req.secure from the socket and the configured trusted proxy
  // chain. Reading X-Forwarded-Proto directly would trust a spoofed client header.
  return req.secure;
}

async function overLimit(entries: Array<{ key: string; max: number }>): Promise<boolean> {
  const counts = await Promise.all(entries.map(async ({ key, max }) => {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count > max;
  }));
  return counts.some(Boolean);
}

async function limited(ip: string | undefined, enrollmentId: string): Promise<boolean> {
  const ipHash = createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
  return overLimit([
    { key: `agentv:enroll:ip:${ipHash}`, max: MAX_ENROLLMENT_IP_ATTEMPTS },
    { key: `agentv:enroll:id:${enrollmentId}`, max: MAX_ENROLLMENT_ATTEMPTS }
  ]);
}

async function transactionLimited(ip: string | undefined, transactionId: string): Promise<boolean> {
  const ipHash = createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
  return overLimit([
    { key: `agentv:install:ip:${ipHash}`, max: MAX_TRANSACTION_IP_ATTEMPTS },
    { key: `agentv:install:id:${transactionId}`, max: MAX_TRANSACTION_ATTEMPTS }
  ]);
}

function reject(res: Response, status: number, code: string, message: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: { code, message, retryable: status >= 500 || status === 429 } });
}

function sensitiveResponse(res: Response): Response {
  res.setHeader('Cache-Control', 'no-store');
  return res;
}

function takeTransactionSecret(req: Request): string {
  const secret = String(req.header('x-agentv-transaction-secret') || '');
  if (req.headers) delete req.headers['x-agentv-transaction-secret'];
  return secret;
}

async function transactionRequest(req: Request, res: Response): Promise<{ id: string; secret: string } | null> {
  const id = String(req.params.transactionId || '');
  const secret = takeTransactionSecret(req);
  if (!secureRequest(req)) {
    reject(res, 400, 'HTTPS_REQUIRED', 'AgentV installation transactions require HTTPS');
    return null;
  }
  if (!TRANSACTION_ID_PATTERN.test(id)) {
    reject(res, 400, 'INVALID_TRANSACTION', 'Invalid AgentV installation transaction');
    return null;
  }
  if (await transactionLimited(req.ip, id)) {
    reject(res, 429, 'RATE_LIMITED', 'Too many AgentV installation requests');
    return null;
  }
  return { id, secret };
}

export async function exchangeAgentVEnrollment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = exchangeAgentVEnrollmentSchema.safeParse(req.body);
    if (req.body && typeof req.body === 'object') req.body.enrollmentToken = '[REDACTED]';
    delete (req as Request & { rawBody?: string }).rawBody;
    if (!secureRequest(req)) return reject(res, 400, 'HTTPS_REQUIRED', 'AgentV enrollment requires HTTPS');
    if (!parsed.success) return reject(res, 400, 'INVALID_ENROLLMENT', 'Invalid AgentV enrollment request');
    const { enrollmentToken: token, targetId, purpose } = parsed.data;
    const enrollmentId = parseAgentVEnrollmentToken(token);
    if (!enrollmentId) {
      return reject(res, 400, 'INVALID_ENROLLMENT', 'Invalid AgentV enrollment request');
    }
    if (await limited(req.ip, enrollmentId)) return reject(res, 429, 'RATE_LIMITED', 'Too many AgentV enrollment attempts');
    const exchanged = await repo.agentv.exchangeAgentVEnrollment({ enrollmentId, token, targetId, purpose });
    if (!exchanged) return reject(res, 401, 'INVALID_ENROLLMENT', 'Enrollment token is invalid, expired, or already used');
    sensitiveResponse(res).status(200).json({
      transactionId: exchanged.enrollment.id,
      transactionSecret: exchanged.transactionSecret,
      agentKey: exchanged.agentKey,
      purpose: exchanged.enrollment.purpose,
      accessPolicy: exchanged.enrollment.accessPolicy
    });
  } catch (err) {
    next(err);
  }
}

export async function getAgentVInstallationStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const transaction = await transactionRequest(req, res);
    if (!transaction) return;
    const status = await repo.agentv.getAgentVInstallationStatus(transaction.id, transaction.secret);
    if (!status) return reject(res, 401, 'INVALID_TRANSACTION', 'Invalid AgentV installation transaction');
    sensitiveResponse(res).status(200).json({
      transactionId: transaction.id,
      status: status.enrollment.status,
      credentialState: status.credential.state,
      activeConnected: status.activeConnected
    });
  } catch (err) {
    next(err);
  }
}

export async function commitAgentVInstallation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const transaction = await transactionRequest(req, res);
    if (!transaction) return;
    const committed = await repo.agentv.commitAgentVInstallation(transaction.id, transaction.secret);
    if (!committed) return reject(res, 409, 'INSTALLATION_NOT_VERIFIED', 'AgentV candidate has not completed provisional authentication');
    sensitiveResponse(res).status(200).json({ status: 'completed' });
  } catch (err) {
    next(err);
  }
}

export async function rollbackAgentVInstallation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const transaction = await transactionRequest(req, res);
    if (!transaction) return;
    const rolledBack = await repo.agentv.rollbackAgentVInstallation(transaction.id, transaction.secret);
    if (!rolledBack) return reject(res, 409, 'ROLLBACK_UNAVAILABLE', 'AgentV installation rollback is unavailable');
    sensitiveResponse(res).status(200).json({ status: 'cancelled' });
  } catch (err) {
    next(err);
  }
}
