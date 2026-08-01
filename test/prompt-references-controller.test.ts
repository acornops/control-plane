import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { resolvePromptReferences } from '../src/controllers/prompt-references-controller.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('prompt reference controller', () => {
  it('resolves a well-formed preview request', async () => {
    installWorkspace('viewer');
    const response = await callController(resolvePromptReferences, createRequest(
      { workspaceId: 'workspace-1' },
      { prompt: 'Summarize {{text:focus}}.' }
    ));

    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { blockers: unknown[] }).blockers, []);
    assert.equal(Object.hasOwn(response.body as object, 'parameters'), false);
  });

  it('treats legacy target placeholder syntax as plain authoring text', async () => {
    installWorkspace('viewer');
    const parameterOnly = await callController(resolvePromptReferences, createRequest(
      { workspaceId: 'workspace-1' },
      { prompt: 'Investigate {{target:target}}.' }
    ));
    assert.equal(parameterOnly.statusCode, 200);
    assert.deepEqual((parameterOnly.body as { blockers: unknown[] }).blockers, []);

    const twoParameters = await callController(resolvePromptReferences, createRequest(
      { workspaceId: 'workspace-1' },
      { prompt: 'Compare {{target:first_target}} with {{target:second_target}}.' }
    ));
    assert.equal(twoParameters.statusCode, 200);
    assert.deepEqual((twoParameters.body as { blockers: unknown[] }).blockers, []);

    const retiredRequirement = await callController(resolvePromptReferences, createRequest(
      { workspaceId: 'workspace-1' },
      {
        prompt: 'Investigate.',
        requirements: [{ type: 'target', minimum: 1, maximum: 1, requiredOperations: ['read'] }]
      }
    ));
    assert.equal(retiredRequirement.statusCode, 200);
    assert.deepEqual(
      (retiredRequirement.body as { blockers: Array<{ code: string }> }).blockers.map((blocker) => blocker.code),
      ['PROMPT_REFERENCE_UNKNOWN_TYPE']
    );
  });

  it('rejects unknown and malformed nested fields instead of coercing them', async () => {
    installWorkspace('viewer');
    const invalidBodies = [
      { prompt: 'Run.', mode: 'preview' },
      { prompt: 'Run.', ignored: true },
      { prompt: 'Run.', requirements: [{ type: 'chat', minimum: 1.5, maximum: 20, requiredOperations: ['read'] }] },
      { prompt: 'Run.', requirements: [{ type: 'chat', minimum: 1, maximum: 20, requiredOperations: ['read'], ignored: true }] }
    ];

    for (const body of invalidBodies) {
      const response = await callController(resolvePromptReferences, createRequest(
        { workspaceId: 'workspace-1' },
        body
      ));
      assert.equal(response.statusCode, 400);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        'PROMPT_REFERENCE_REQUEST_INVALID'
      );
    }
  });
});
