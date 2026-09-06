#!/usr/bin/env node
// Minimal optional external-controller fixture. Request files preserve retry identity;
// raw credentials stay in the environment and are never written to a request file.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const base = process.env.ACORNOPS_ADMIN_BASE_URL;
const token = process.env.ACORNOPS_ADMIN_TOKEN;
async function request(method, path, body) {
  if (!base || !token) throw new Error('Set ACORNOPS_ADMIN_BASE_URL and ACORNOPS_ADMIN_TOKEN');
  const response = await fetch(new URL(path, base), {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Policy request failed: ${result.error?.code || response.status}`);
  return result;
}
async function main() {
  const [command, workspaceOrFile, action, value, output] = process.argv.slice(2);
  if (command === 'apply') {
    const prepared = JSON.parse(await readFile(workspaceOrFile, 'utf8'));
    if (!/^\/admin\/v1\/workspaces\/[^/?#]+\/(plan|suspend|restore)$/.test(prepared.path)
      || !['PATCH', 'POST'].includes(prepared.method)
      || !prepared.body?.requestId || !Number.isInteger(prepared.body?.expectedPolicyVersion)) throw new Error('Invalid prepared policy request');
    const result = await request(prepared.method, prepared.path, prepared.body);
    console.log(JSON.stringify({ changed: result.changed, policyVersion: result.policy?.policyVersion, lifecycleStatus: result.policy?.lifecycleStatus }));
    return;
  }
  if (command !== 'prepare' || !workspaceOrFile || !['plan', 'suspend', 'restore'].includes(action) || !output) {
    throw new Error('Usage: prepare workspaceId plan|suspend|restore planKey|- request.json; apply request.json');
  }
  const workspacePath = `/admin/v1/workspaces/${encodeURIComponent(workspaceOrFile)}`;
  const policy = await request('GET', `${workspacePath}/policy`);
  if (action === 'plan') {
    const catalogue = await request('GET', '/admin/v1/workspace-plans');
    if (!catalogue.plans.some(plan => plan.key === value)) throw new Error('Plan is not configured');
  }
  const body = { requestId: randomUUID(), expectedPolicyVersion: policy.policyVersion,
    reason: `external_controller_${action}`,
    ...(action === 'plan' ? { planKey: value, overLimitBehavior: 'reject' }
      : { source: 'external', workspaceName: policy.workspaceName }) };
  await writeFile(output, `${JSON.stringify({ method: action === 'plan' ? 'PATCH' : 'POST', path: `${workspacePath}/${action}`, body }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Prepared policy request. Reuse this file unchanged for retries.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Controller request failed'); process.exitCode = 1; });
