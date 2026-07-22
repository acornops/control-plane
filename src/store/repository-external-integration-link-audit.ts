import type { PoolClient } from 'pg';
import { insertAccountAuditEvent } from './repository-account-audit.js';

interface CompletedExternalIntegrationLink {
  id: string;
  integrationClientId: string;
  provider: string;
  clientDisplayName: string;
  externalUserId: string;
  externalDisplayName?: string;
}

export async function recordExternalIntegrationLinkCompletion(
  client: PoolClient,
  userId: string,
  link: CompletedExternalIntegrationLink
): Promise<void> {
  await insertAccountAuditEvent({
    userId,
    category: 'security',
    eventType: 'external_integration.link.completed.v1',
    operation: 'write',
    actorType: 'user',
    actorUserId: userId,
    objectType: 'external_integration_link',
    objectId: link.id,
    objectName: `${link.integrationClientId}:${link.provider}:${link.externalUserId}`,
    summary: 'External integration account link completed',
    metadata: {
      integrationClientId: link.integrationClientId,
      provider: link.provider,
      clientDisplayName: link.clientDisplayName,
      externalUserId: link.externalUserId,
      externalDisplayName: link.externalDisplayName || null
    }
  }, client);
}
