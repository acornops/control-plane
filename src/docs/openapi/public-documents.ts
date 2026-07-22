import { buildOpenApiDocument } from '../openapi.js';
import { assertOpenApiSchemaCoverage, OpenApiLikeDocument } from './schema-coverage.js';

type PublicOpenApiAudience = 'public' | 'admin';

const publicBaseUrl = 'https://api.acornops.dev';
const sessionCookieName = 'acornops_cp_session';
const allowedPublicPathPrefix = '/api/v1';
const allowedAdminPathPrefix = '/admin/v1';
const excludedPublicPaths = new Set(['/api/v1/auth/dev-login']);
const componentReferencePrefix = '#/components/';

function cloneDocument<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function operationCount(document: OpenApiLikeDocument): number {
  let count = 0;
  for (const pathItem of Object.values(document.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (['get', 'post', 'patch', 'delete', 'put'].includes(method)) count += 1;
    }
  }
  return count;
}

function filterPaths(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): void {
  for (const path of Object.keys(document.paths)) {
    const keep =
      audience === 'public'
        ? path.startsWith(allowedPublicPathPrefix) && !excludedPublicPaths.has(path)
        : path.startsWith(allowedAdminPathPrefix);
    if (!keep) {
      delete document.paths[path];
    }
  }
}

function assertNoForbiddenPaths(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): void {
  const failures: string[] = [];
  for (const path of Object.keys(document.paths)) {
    if (path.startsWith('/internal/') || path === '/health' || path === '/ready' || path === '/metrics') {
      failures.push(`forbidden path exported: ${path}`);
    }
    if (audience === 'public') {
      if (!path.startsWith(allowedPublicPathPrefix)) failures.push(`path outside /api/v1 exported: ${path}`);
      if (excludedPublicPaths.has(path)) failures.push(`dev-only path exported: ${path}`);
    }
    if (audience === 'admin' && !path.startsWith(allowedAdminPathPrefix)) {
      failures.push(`non-admin path exported: ${path}`);
    }
  }
  if (operationCount(document) === 0) {
    failures.push(`no operations exported for ${audience} OpenAPI document`);
  }
  if (failures.length > 0) {
    throw new Error(`OpenAPI export validation failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }
}

function normalizeDocument(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): OpenApiLikeDocument {
  document.components.securitySchemes =
    audience === 'public'
      ? {
          userSession: document.components.securitySchemes.userSession,
          externalIntegrationClientToken: document.components.securitySchemes.externalIntegrationClientToken
        }
      : { adminBearer: document.components.securitySchemes.adminBearer };
  return document;
}

function parameterComponentBase(parameter: Record<string, unknown>): string {
  const location = typeof parameter.in === 'string' ? parameter.in : 'parameter';
  const name = typeof parameter.name === 'string' ? parameter.name : 'value';
  return `${location}-${name}`
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function reuseCommonParameters(document: OpenApiLikeDocument): void {
  const counts = new Map<string, { parameter: Record<string, unknown>; count: number }>();
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (!Array.isArray(operation.parameters)) continue;
      for (const parameter of operation.parameters) {
        if (!parameter || typeof parameter !== 'object' || '$ref' in parameter) continue;
        const key = JSON.stringify(parameter);
        const current = counts.get(key);
        counts.set(key, { parameter: parameter as Record<string, unknown>, count: (current?.count ?? 0) + 1 });
      }
    }
  }

  const reusable = [...counts.entries()]
    .filter(([, value]) => value.count >= 3)
    .sort(([left], [right]) => left.localeCompare(right));
  if (reusable.length === 0) return;

  const namesByValue = new Map<string, string>();
  const usedNames = new Set<string>();
  const components: Record<string, unknown> = {};
  for (const [key, { parameter }] of reusable) {
    const base = parameterComponentBase(parameter);
    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${base}${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    namesByValue.set(key, name);
    components[name] = parameter;
  }
  document.components.parameters = { ...(document.components.parameters ?? {}), ...components };

  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (!Array.isArray(operation.parameters)) continue;
      operation.parameters = operation.parameters.map((parameter) => {
        if (!parameter || typeof parameter !== 'object' || '$ref' in parameter) return parameter;
        const name = namesByValue.get(JSON.stringify(parameter));
        return name ? { $ref: `${componentReferencePrefix}parameters/${name}` } : parameter;
      });
    }
  }
}

function collectReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, references);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof entry === 'string' && entry.startsWith(componentReferencePrefix)) {
      references.add(entry);
    } else {
      collectReferences(entry, references);
    }
  }
}

function resolveComponentReference(document: OpenApiLikeDocument, reference: string): unknown {
  const [group, name, ...rest] = reference.slice(componentReferencePrefix.length).split('/');
  if (!group || !name || rest.length > 0) return undefined;
  return document.components[group]?.[name];
}

function componentKey(reference: string): string {
  return reference.slice(componentReferencePrefix.length);
}

function pruneUnreachableComponents(document: OpenApiLikeDocument): void {
  const pending = new Set<string>();
  collectReferences({ paths: document.paths }, pending);

  // OpenAPI security requirement objects name schemes rather than using $ref.
  for (const name of Object.keys(document.components.securitySchemes)) {
    pending.add(`${componentReferencePrefix}securitySchemes/${name}`);
  }

  const reachable = new Set<string>();
  while (pending.size > 0) {
    const reference = pending.values().next().value as string;
    pending.delete(reference);
    const key = componentKey(reference);
    if (reachable.has(key)) continue;
    const component = resolveComponentReference(document, reference);
    if (component === undefined) {
      throw new Error(`OpenAPI export contains unresolved reference: ${reference}`);
    }
    reachable.add(key);
    const nested = new Set<string>();
    collectReferences(component, nested);
    for (const nestedReference of nested) pending.add(nestedReference);
  }

  for (const [group, components] of Object.entries(document.components)) {
    if (!components) continue;
    for (const name of Object.keys(components)) {
      if (!reachable.has(`${group}/${name}`)) delete components[name];
    }
    if (Object.keys(components).length === 0) delete document.components[group];
  }
}

function sortRecord<T>(record: Record<string, T>, compare?: (left: string, right: string) => number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => (
    compare ? compare(left, right) : left.localeCompare(right)
  )));
}

function sortDocument(document: OpenApiLikeDocument): void {
  const methodOrder = ['get', 'post', 'put', 'patch', 'delete', 'parameters'];
  document.paths = sortRecord(document.paths);
  for (const [path, pathItem] of Object.entries(document.paths)) {
    document.paths[path] = sortRecord(pathItem, (left, right) => {
      const leftIndex = methodOrder.indexOf(left);
      const rightIndex = methodOrder.indexOf(right);
      if (leftIndex === -1 || rightIndex === -1) return left.localeCompare(right);
      return leftIndex - rightIndex;
    });
    for (const operation of Object.values(document.paths[path])) {
      if (operation.responses) operation.responses = sortRecord(operation.responses, (left, right) => {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        return Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
          ? left.localeCompare(right)
          : leftNumber - rightNumber;
      });
    }
  }
  document.components = sortRecord(document.components) as OpenApiLikeDocument['components'];
  for (const [group, components] of Object.entries(document.components)) {
    if (components) document.components[group] = sortRecord(components);
  }
}

function assertAllComponentsReachable(document: OpenApiLikeDocument): void {
  const referenced = new Set<string>();
  collectReferences({ paths: document.paths }, referenced);
  for (const name of Object.keys(document.components.securitySchemes ?? {})) {
    referenced.add(`${componentReferencePrefix}securitySchemes/${name}`);
  }
  const pending = [...referenced];
  const reachable = new Set<string>();
  while (pending.length > 0) {
    const reference = pending.pop() as string;
    const key = componentKey(reference);
    if (reachable.has(key)) continue;
    const component = resolveComponentReference(document, reference);
    if (component === undefined) throw new Error(`OpenAPI export contains unresolved reference: ${reference}`);
    reachable.add(key);
    const nested = new Set<string>();
    collectReferences(component, nested);
    pending.push(...nested);
  }
  const unreachable = Object.entries(document.components).flatMap(([group, components]) => (
    Object.keys(components ?? {}).filter((name) => !reachable.has(`${group}/${name}`)).map((name) => `${group}/${name}`)
  ));
  if (unreachable.length > 0) {
    throw new Error(`OpenAPI export contains unreachable components:\n${unreachable.map((name) => `- ${name}`).join('\n')}`);
  }
}

export function buildPublicOpenApiDocument(audience: PublicOpenApiAudience): OpenApiLikeDocument {
  const document = cloneDocument(buildOpenApiDocument(publicBaseUrl, sessionCookieName)) as unknown as OpenApiLikeDocument;
  filterPaths(document, audience);
  normalizeDocument(document, audience);
  reuseCommonParameters(document);
  pruneUnreachableComponents(document);
  sortDocument(document);
  assertNoForbiddenPaths(document, audience);
  assertOpenApiSchemaCoverage(document);
  assertAllComponentsReachable(document);
  return document;
}

export function assertPublicOpenApiDocument(document: OpenApiLikeDocument, audience: PublicOpenApiAudience): void {
  assertNoForbiddenPaths(document, audience);
  assertOpenApiSchemaCoverage(document);
  assertAllComponentsReachable(document);
}
