import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  clearOidcBrowserTransactionCookie,
  createOidcBrowserTransaction,
  oidcBrowserBindingHash,
  setOidcBrowserTransactionCookie
} from '../src/auth/oidc-transaction.js';
import { config } from '../src/config.js';

const mutableConfig = config as typeof config & { NODE_ENV: 'development' | 'test' | 'production' };
const originalNodeEnv = config.NODE_ENV;

afterEach(() => {
  mutableConfig.NODE_ENV = originalNodeEnv;
});

describe('OIDC browser transaction binding', () => {
  it('uses a short-lived HttpOnly callback cookie and derives a stable server-side hash', () => {
    mutableConfig.NODE_ENV = 'production';
    const transaction = createOidcBrowserTransaction();
    const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    const cleared: Array<{ name: string; options: Record<string, unknown> }> = [];
    const res = {
      cookie(name: string, value: string, options: Record<string, unknown>) {
        cookies.push({ name, value, options });
      },
      clearCookie(name: string, options: Record<string, unknown>) {
        cleared.push({ name, options });
      }
    };

    setOidcBrowserTransactionCookie(res as never, transaction.cookieValue);
    const binding = oidcBrowserBindingHash({
      cookies: { [cookies[0].name]: transaction.cookieValue }
    } as never);
    clearOidcBrowserTransactionCookie(res as never);

    assert.equal(binding, transaction.bindingHash);
    assert.equal(cookies[0].value, transaction.cookieValue);
    assert.deepEqual(cookies[0].options, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600_000,
      path: '/api/v1/auth/oidc/callback'
    });
    assert.deepEqual(cleared, [{
      name: cookies[0].name,
      options: { path: '/api/v1/auth/oidc/callback' }
    }]);
  });

  it('rejects missing and malformed transaction cookies', () => {
    assert.equal(oidcBrowserBindingHash({ cookies: {} } as never), undefined);
    assert.equal(oidcBrowserBindingHash({ cookies: { arbitrary: 'short' } } as never), undefined);
  });
});
