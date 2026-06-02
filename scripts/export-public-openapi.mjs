import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import publicDocuments from '../src/docs/openapi/public-documents.js';

const { buildPublicOpenApiDocument } = publicDocuments;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.resolve(root, '..', 'docs-website');
const outputDir = path.join(docsRoot, 'openapi');

const outputs = [
  ['public', 'control-plane-public.json'],
  ['admin', 'control-plane-admin.json']
];

fs.mkdirSync(outputDir, { recursive: true });

for (const [audience, fileName] of outputs) {
  const document = buildPublicOpenApiDocument(audience);
  const outputPath = path.join(outputDir, fileName);
  fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${path.relative(root, outputPath)}`);
}
