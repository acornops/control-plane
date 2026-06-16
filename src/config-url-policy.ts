export interface ConfigIssue {
  field: string;
  message: string;
}

function isClusterInternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'http:' && (hostname.endsWith('.svc') || hostname.endsWith('.svc.cluster.local'));
  } catch {
    return false;
  }
}

export function httpsUrlProductionIssues(field: string, value: string): ConfigIssue[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [{ field, message: `${field} must be a valid URL in production` }];
  }

  const issues: ConfigIssue[] = [];
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') {
    issues.push({ field, message: `${field} must use https in production` });
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1') {
    issues.push({ field, message: `${field} must not point at localhost in production` });
  }
  return issues;
}

export function oidcIssuerProductionIssues(issuerUrl: string, publicIssuerUrl?: string): ConfigIssue[] {
  if (!isClusterInternalHttpUrl(issuerUrl)) {
    return httpsUrlProductionIssues('OIDC_ISSUER_URL', issuerUrl);
  }
  if (!publicIssuerUrl) {
    return [{
      field: 'OIDC_PUBLIC_ISSUER_URL',
      message: 'OIDC_PUBLIC_ISSUER_URL is required when OIDC_ISSUER_URL uses a cluster-local HTTP endpoint'
    }];
  }
  return [];
}

export function httpsInternalUrlConfigIssues(field: string, value: string): ConfigIssue[] {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      return [{ field, message: `${field} must use https when internal transport TLS is enabled` }];
    }
    return [];
  } catch {
    return [{ field, message: `${field} must be a valid URL when internal transport TLS is enabled` }];
  }
}
