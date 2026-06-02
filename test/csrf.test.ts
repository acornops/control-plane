import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { csrfProtection, getOrSetCsrfToken, isValidCsrfToken } from '../src/auth/csrf.js';
import { config } from '../src/config.js';

const mutableConfig = config as typeof config & {
  CONTROL_PLANE_BASE_URL: string;
  CORS_ORIGIN: string;
  NODE_ENV: 'development' | 'test' | 'production';
};

const originalBaseUrl = config.CONTROL_PLANE_BASE_URL;
const originalCorsOrigin = config.CORS_ORIGIN;
const originalNodeEnv = config.NODE_ENV;

afterEach(() => {
  mutableConfig.CONTROL_PLANE_BASE_URL = originalBaseUrl;
  mutableConfig.CORS_ORIGIN = originalCorsOrigin;
  mutableConfig.NODE_ENV = originalNodeEnv;
});

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    cookies: new Map<string, string>(),
    cookie(name: string, value: string) {
      this.cookies.set(name, value);
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

function createRequest(input: {
  method: string;
  path?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const headers = new Map(Object.entries(input.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: input.method,
    path: input.path || '/api/v1/workspaces/workspace-1',
    cookies: input.cookies || {},
    header(name: string) {
      return headers.get(name.toLowerCase());
    }
  };
}

describe('csrfProtection', () => {
  it('sets a signed CSRF cookie on safe requests', () => {
    const req = createRequest({ method: 'GET' });
    const res = createResponse();
    let nextCalled = false;

    csrfProtection(req as never, res as never, () => {
      nextCalled = true;
    });

    const token = res.cookies.get(config.CSRF_COOKIE_NAME);
    assert.equal(nextCalled, true);
    assert.equal(isValidCsrfToken(token), true);
  });

  it('rejects cookie-authenticated mutations without a matching header token', () => {
    const req = createRequest({
      method: 'POST',
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' },
      headers: { origin: 'https://console.example.com' }
    });
    const res = createResponse();
    let nextCalled = false;

    mutableConfig.CORS_ORIGIN = 'https://console.example.com';
    csrfProtection(req as never, res as never, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it('rejects cookie-authenticated mutations from disallowed origins', () => {
    const safeReq = createRequest({ method: 'GET' });
    const safeRes = createResponse();
    const token = getOrSetCsrfToken(safeReq as never, safeRes as never);
    const req = createRequest({
      method: 'POST',
      cookies: {
        [config.SESSION_COOKIE_NAME]: 'session-1',
        [config.CSRF_COOKIE_NAME]: token
      },
      headers: {
        origin: 'https://attacker.example.com',
        [config.CSRF_HEADER_NAME]: token
      }
    });
    const res = createResponse();
    let nextCalled = false;

    mutableConfig.CORS_ORIGIN = 'https://console.example.com';
    csrfProtection(req as never, res as never, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it('rejects unauthenticated password auth mutations without a matching token', () => {
    const paths = [
      '/api/v1/auth/password/login',
      '/api/v1/auth/password/signup',
      '/api/v1/auth/password/verify-email',
      '/api/v1/auth/password/resend-verification',
      '/api/v1/auth/password/forgot',
      '/api/v1/auth/password/reset'
    ];

    mutableConfig.CORS_ORIGIN = 'https://console.example.com';
    for (const path of paths) {
      const req = createRequest({
        method: 'POST',
        path,
        headers: { origin: 'https://console.example.com' }
      });
      const res = createResponse();
      let nextCalled = false;
      csrfProtection(req as never, res as never, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, path);
      assert.equal(res.statusCode, 403, path);
    }
  });

  it('allows unauthenticated password auth mutations with a valid token and allowed origin', () => {
    const safeReq = createRequest({ method: 'GET' });
    const safeRes = createResponse();
    const token = getOrSetCsrfToken(safeReq as never, safeRes as never);
    const req = createRequest({
      method: 'POST',
      path: '/api/v1/auth/password/signup',
      cookies: { [config.CSRF_COOKIE_NAME]: token },
      headers: {
        origin: 'https://console.example.com',
        [config.CSRF_HEADER_NAME]: token
      }
    });
    const res = createResponse();
    let nextCalled = false;

    mutableConfig.CORS_ORIGIN = 'https://console.example.com';
    csrfProtection(req as never, res as never, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('allows cookie-authenticated mutations with a valid token and allowed origin', () => {
    const safeReq = createRequest({ method: 'GET' });
    const safeRes = createResponse();
    const token = getOrSetCsrfToken(safeReq as never, safeRes as never);
    const req = createRequest({
      method: 'PATCH',
      cookies: {
        [config.SESSION_COOKIE_NAME]: 'session-1',
        [config.CSRF_COOKIE_NAME]: token
      },
      headers: {
        origin: 'https://console.example.com',
        [config.CSRF_HEADER_NAME]: token
      }
    });
    const res = createResponse();
    let nextCalled = false;

    mutableConfig.CORS_ORIGIN = 'https://console.example.com';
    csrfProtection(req as never, res as never, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });
});
