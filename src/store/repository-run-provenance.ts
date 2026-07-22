import { db } from '../infra/db.js';

export interface RunRequestProvenance {
  actorType: 'user' | 'external_integration';
  externalIntegrationLinkId?: string;
  externalIntegrationClientId?: string;
}

export async function getRunRequestProvenance(runId: string): Promise<RunRequestProvenance | null> {
  const result = await db.query<{
    request_actor_type: RunRequestProvenance['actorType'];
    request_external_integration_link_id: string | null;
    request_external_integration_client_id: string | null;
  }>(
    `SELECT request_actor_type, request_external_integration_link_id,
            request_external_integration_client_id
       FROM runs
      WHERE id = $1`,
    [runId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    actorType: row.request_actor_type,
    ...(row.request_external_integration_link_id
      ? { externalIntegrationLinkId: row.request_external_integration_link_id }
      : {}),
    ...(row.request_external_integration_client_id
      ? { externalIntegrationClientId: row.request_external_integration_client_id }
      : {})
  };
}
