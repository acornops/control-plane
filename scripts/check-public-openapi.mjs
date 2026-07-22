import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import publicDocuments from '../src/docs/openapi/public-documents.js';

const { buildPublicOpenApiDocument } = publicDocuments;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsOpenApiRoot = path.resolve(root, '..', 'docs-website', 'openapi');
const filenames = { public: 'control-plane-public.json', admin: 'control-plane-admin.json' };
let combinedLineCount = 0;

for (const audience of ['public', 'admin']) {
  const document = buildPublicOpenApiDocument(audience);
  const secondDocument = buildPublicOpenApiDocument(audience);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (serialized !== `${JSON.stringify(secondDocument, null, 2)}\n`) {
    throw new Error(`${audience} OpenAPI generation is not deterministic`);
  }
  const generatedPath = path.join(docsOpenApiRoot, filenames[audience]);
  if (existsSync(generatedPath)) {
    const checkedIn = readFileSync(generatedPath, 'utf8');
    if (checkedIn !== serialized) {
      const expectedLines = serialized.split('\n').length - 1;
      const actualLines = checkedIn.split('\n').length - 1;
      throw new Error(
        `${audience} OpenAPI artifact is stale (${actualLines} checked-in lines; ${expectedLines} generated lines). `
        + 'Run npm run openapi:export.'
      );
    }
  }
  const pathCount = Object.keys(document.paths).length;
  const schemaCount = Object.keys(document.components.schemas ?? {}).length;
  for (const [apiPath, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      for (const [statusCode, response] of Object.entries(operation.responses ?? {})) {
        if (response.description === 'Error response.') {
          throw new Error(`${method.toUpperCase()} ${apiPath} ${statusCode} contains an inline generic error response`);
        }
      }
    }
  }
  const lineCount = serialized.split('\n').length - 1;
  combinedLineCount += lineCount;
  const lineLimit = audience === 'admin' ? 3000 : 27000;
  if (lineCount > lineLimit) {
    throw new Error(`${audience} OpenAPI document has ${lineCount} lines; expected at most ${lineLimit}`);
  }
  console.log(`${audience} OpenAPI document passed coverage checks (${pathCount} paths, ${schemaCount} schemas).`);
}

if (combinedLineCount > 29200) {
  throw new Error(`Combined generated OpenAPI has ${combinedLineCount} lines; expected at most 29200`);
}
