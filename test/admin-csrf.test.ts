import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getOrSetAdminCsrfToken, validAdminCsrfRequest, validAdminCsrfToken } from '../src/auth/admin-csrf.js';
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
});
