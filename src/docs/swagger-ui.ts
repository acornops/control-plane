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
      href="https://unpkg.com/swagger-ui-dist@5.20.2/swagger-ui.css"
    />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script nonce="${safeNonce}" src="https://unpkg.com/swagger-ui-dist@5.20.2/swagger-ui-bundle.js"></script>
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
