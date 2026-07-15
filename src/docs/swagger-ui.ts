import { dirname, join } from 'node:path';

const swaggerUiPackageJsonPath = require.resolve('swagger-ui-dist/package.json');
const swaggerUiPackage = require(swaggerUiPackageJsonPath) as { version: string };
const swaggerUiDistPath = dirname(swaggerUiPackageJsonPath);

export const SWAGGER_UI_ASSET_NAMES = ['swagger-ui.css', 'swagger-ui-bundle.js'] as const;
export type SwaggerUiAssetName = typeof SWAGGER_UI_ASSET_NAMES[number];
export const SWAGGER_UI_ASSET_BASE_PATH =
  `/docs/assets/swagger-ui-dist-${encodeURIComponent(swaggerUiPackage.version)}`;

export function swaggerUiAssetFile(assetName: SwaggerUiAssetName): string {
  return join(swaggerUiDistPath, assetName);
}

function escapeForSingleQuotedJs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function renderSwaggerUiHtml(openApiPath: string, nonce: string): string {
  const safePath = escapeForSingleQuotedJs(openApiPath);
  const safeNonce = nonce.replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AcornOps Control Plane API Docs</title>
    <link
      rel="stylesheet"
      href="${SWAGGER_UI_ASSET_BASE_PATH}/swagger-ui.css"
    />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script nonce="${safeNonce}" src="${SWAGGER_UI_ASSET_BASE_PATH}/swagger-ui-bundle.js"></script>
    <script nonce="${safeNonce}">
      window.ui = SwaggerUIBundle({
        url: '${safePath}',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis]
      });
    </script>
  </body>
</html>`;
}
