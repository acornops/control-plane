export type AdminOidcFailure = {
  reason: string;
  status: number;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

const unavailableReasons = new Set([
  'ADMIN_OIDC_DISCOVERY_UNAVAILABLE',
  'ADMIN_OIDC_TOKEN_ENDPOINT_UNAVAILABLE',
  'ADMIN_OIDC_JWKS_UNAVAILABLE'
]);

const configurationReasons = new Set([
  'ADMIN_OIDC_DISCOVERY_INVALID',
  'ADMIN_OIDC_DISCOVERY_REJECTED',
  'ADMIN_OIDC_ISSUER_MISMATCH',
  'ADMIN_OIDC_CLIENT_SECRET_REQUIRED'
]);

export class AdminOidcError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AdminOidcError';
  }
}
export function adminOidcFailure(error: unknown): AdminOidcFailure {
  const reason = error instanceof Error ? error.message : 'ADMIN_OIDC_LOGIN_FAILED';
  if (unavailableReasons.has(reason)) {
    return {
      reason,
      status: 503,
      error: {
        code: 'ADMIN_IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'Platform administrator sign-in is temporarily unavailable',
        retryable: true
      }
    };
  }
  if (configurationReasons.has(reason)) {
    return {
      reason,
      status: 503,
      error: {
        code: 'ADMIN_IDENTITY_PROVIDER_MISCONFIGURED',
        message: 'Platform administrator sign-in is unavailable',
        retryable: false
      }
    };
  }
  if (reason === 'ADMIN_ROLE_REQUIRED' || reason === 'ADMIN_MFA_REQUIRED') {
    return {
      reason,
      status: 403,
      error: {
        code: reason,
        message: 'Platform administrator sign-in was not accepted',
        retryable: false
      }
    };
  }
  if (reason.startsWith('ADMIN_OIDC_')) {
    return {
      reason,
      status: 401,
      error: {
        code: 'ADMIN_SIGN_IN_REJECTED',
        message: 'Platform administrator sign-in was not accepted',
        retryable: false
      }
    };
  }
  return {
    reason: 'ADMIN_OIDC_INTERNAL_FAILURE',
    status: 503,
    error: {
      code: 'ADMIN_SIGN_IN_UNAVAILABLE',
      message: 'Platform administrator sign-in is temporarily unavailable',
      retryable: true
    }
  };
}
