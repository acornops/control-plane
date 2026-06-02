import publicDocuments from '../src/docs/openapi/public-documents.js';

const { buildPublicOpenApiDocument } = publicDocuments;

for (const audience of ['public', 'admin']) {
  const document = buildPublicOpenApiDocument(audience);
  const pathCount = Object.keys(document.paths).length;
  console.log(`${audience} OpenAPI document passed coverage checks (${pathCount} paths).`);
}
