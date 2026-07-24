import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearAdminCsrfCookie,
  getOrSetAdminCsrfToken,
  requireAdminCsrf,
  validAdminCsrfRequest,
  validAdminCsrfToken
} from '../src/auth/admin-csrf.js';
import { config } from '../src/config.js';

describe('platform admin CSRF policy', () => {
  it('requires the signed double-submit token and exact console origin', () => {
    let cookieValue = '';
    const response = { cookie: (_name: string, value: string) => { cookieValue = value; } };
    const token = getOrSetAdminCsrfToken({ cookies: {} } as never, response as never);
    assert.equal(token, cookieValue);
    assert.equal(validAdminCsrfToken(token), true);

    const request = (origin: string, header = token) => ({
      cookies: { [config.ADMIN_CSRF_COOKIE_NAME]: token },
      header: (name: string) => name === 'origin' ? origin : name === config.ADMIN_CSRF_HEADER_NAME ? header : undefined
    });
    assert.equal(validAdminCsrfRequest(request(new URL(config.PLATFORM_ADMIN_CONSOLE_BASE_URL).origin) as never), true);
    assert.equal(validAdminCsrfRequest(request('https://attacker.example.test') as never), false);
    assert.equal(validAdminCsrfRequest(request(new URL(config.PLATFORM_ADMIN_CONSOLE_BASE_URL).origin, 'tampered') as never), false);
  });

  it('rejects logout-style requests without valid same-origin CSRF evidence', () => {
    let cookieValue = '';
    const token = getOrSetAdminCsrfToken(
      { cookies: {} } as never,
      { cookie: (_name: string, value: string) => { cookieValue = value; } } as never
    );
    assert.equal(token, cookieValue);
    const response = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; }
    };
    let accepted = false;
    requireAdminCsrf({
      cookies: { [config.ADMIN_CSRF_COOKIE_NAME]: token },
      header: (name: string) => name === 'origin' ? 'https://attacker.example.test' : name === config.ADMIN_CSRF_HEADER_NAME ? token : undefined
    } as never, response as never, () => { accepted = true; });
    assert.equal(accepted, false);
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'CSRF_TOKEN_REQUIRED');
  });

  it('clears the host-only CSRF cookie with its security attributes intact', () => {
    let cleared: { name: string; options: Record<string, unknown> } | undefined;
    clearAdminCsrfCookie({
      clearCookie: (name: string, options: Record<string, unknown>) => { cleared = { name, options }; }
    } as never);
    assert.deepEqual(cleared, {
      name: config.ADMIN_CSRF_COOKIE_NAME,
      options: {
        httpOnly: false,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
      }
    });
  });
});
