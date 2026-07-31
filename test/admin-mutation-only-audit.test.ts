import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import * as ts from 'typescript';

const auditWriteCall = /\b(?:auditAdmin|auditAdminMutationRequest|adminAuditEventInput|insertAdminAuditEvent)\s*\(/;

test('admin controllers contain no read-only audit actions', async () => {
  const controllerDirectory = new URL('../src/controllers/', import.meta.url);
  const controllerFiles = (await readdir(controllerDirectory))
    .filter((file) => file.startsWith('admin-') && file.endsWith('.ts'));

  for (const file of controllerFiles) {
    const source = await readFile(new URL(file, controllerDirectory), 'utf8');
    assert.doesNotMatch(
      source,
      /action:\s*'admin\.[^']+\.(?:read|search)'/,
      `${file} must not persist read-only admin audit actions`
    );
  }
});

test('registered admin GET handlers contain no audit-write calls', async () => {
  const routeSource = await readFile(new URL('../src/routes/admin.ts', import.meta.url), 'utf8');
  const getHandlers = [...routeSource.matchAll(
    /adminRouter\.get\([\s\S]*?adminHandler\(adminController\.(\w+)\)\s*\)\s*;/g
  )].map((match) => match[1]);
  assert.ok(getHandlers.length >= 10, 'expected the registered admin GET surface');

  const controllerDirectory = new URL('../src/controllers/', import.meta.url);
  const controllerFiles = (await readdir(controllerDirectory))
    .filter((file) => file.startsWith('admin-') && file.endsWith('.ts'));
  const handlers = new Map<string, string>();
  for (const file of controllerFiles) {
    const source = await readFile(new URL(file, controllerDirectory), 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    sourceFile.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        handlers.set(node.name.text, node.body.getText(sourceFile));
      }
    });
  }

  for (const handlerName of getHandlers) {
    const body = handlers.get(handlerName);
    assert.ok(body, `registered GET handler ${handlerName} must be discoverable`);
    assert.doesNotMatch(body, auditWriteCall, `${handlerName} must not write Admin Audit`);
  }
});
