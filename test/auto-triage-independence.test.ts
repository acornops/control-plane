import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const coreModules = [
  'src/controllers/workspaces/auto-triage-controller.ts',
  'src/services/auto-triage-policy.ts',
  'src/services/auto-triage-run-creation.ts',
  'src/services/auto-triage-run-transitions.ts',
  'src/services/auto-triage-retry-timing.ts',
  'src/services/auto-triage-worker.ts',
  'src/store/repository-auto-triage.ts',
  'src/store/repository-auto-triage-activity.ts',
  'src/store/repository-auto-triage-job-mappers.ts',
  'src/store/repository-auto-triage-leases.ts',
  'src/store/repository-auto-triage-manual-actions.ts',
  'src/store/repository-auto-triage-mappers.ts',
  'src/store/repository-auto-triage-requeue.ts',
  'src/store/repository-target-issue-auto-triage.ts',
  'src/utils/auto-triage-instructions.ts'
];

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('target auto-triage architecture independence', () => {
  it('does not import Workflow or Automation feature modules from its core runtime', () => {
    for (const path of coreModules) {
      assert.doesNotMatch(
        source(path),
        /from\s+['"][^'"]*(?:workflow|automation)[^'"]*['"]/i,
        `${path} must not depend on Workflow or Automation feature modules`
      );
    }
  });

  it('uses target permissions rather than Workflow permissions', () => {
    const controller = source('src/controllers/workspaces/auto-triage-controller.ts');
    assert.match(controller, /'manage_targets'/);
    assert.match(controller, /'create_read_write_runs'/);
    assert.doesNotMatch(controller, /manage_workflows/);
  });

  it('runs on a dedicated timer and error boundary', () => {
    const server = source('src/server.ts');
    const automationStart = server.indexOf('const automationWorkerInterval');
    const autoTriageStart = server.indexOf('const targetAutoTriageWorkerInterval');
    assert.ok(automationStart >= 0);
    assert.ok(autoTriageStart > automationStart);

    const automationBlock = server.slice(automationStart, autoTriageStart);
    const autoTriageBlock = server.slice(autoTriageStart, server.indexOf('let webhookSweepInFlight'));
    assert.doesNotMatch(automationBlock, /runTargetAutoTriageTick/);
    assert.match(autoTriageBlock, /runTargetAutoTriageTick/);
    assert.match(autoTriageBlock, /Target auto-triage worker tick failed/);
    assert.match(autoTriageBlock, /if \(targetAutoTriageTickInFlight\) return/);
    assert.match(autoTriageBlock, /targetAutoTriageTickInFlight = false/);
    assert.doesNotMatch(autoTriageBlock, /AUTOMATION_RUNTIME_MODE|AUTOMATION_WORKER_INTERVAL_MS/);
    assert.match(server, /clearInterval\(targetAutoTriageWorkerInterval\)/);
  });

  it('keeps worker run mutations behind the lease-fenced transition helpers', () => {
    const worker = source('src/services/auto-triage-worker.ts');
    const processingPaths = worker.slice(worker.indexOf('async function dispatchLinkedRun'));
    assert.doesNotMatch(
      processingPaths,
      /repo\.updateRun\(/,
      'job processing must not mutate a linked run outside the claimed-job transaction'
    );
  });
});
