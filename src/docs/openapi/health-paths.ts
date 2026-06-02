export function buildHealthPaths(): Record<string, unknown> {
  return {
'/health': {
        get: {
          tags: ['health'],
          summary: 'Service liveness health check',
          responses: { '200': { description: 'Healthy service status.' } }
        }
      },
      '/ready': {
        get: {
          tags: ['health'],
          summary: 'Service readiness check',
          responses: {
            '200': { description: 'Ready: dependencies reachable.' },
            '503': { description: 'Degraded: one or more dependencies unavailable.' }
          }
        }
      },
      '/metrics': {
        get: {
          tags: ['health'],
          summary: 'Prometheus metrics payload',
          responses: { '200': { description: 'Metrics payload.' } }
        }
      },
  };
}
