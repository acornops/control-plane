export interface ExternalWebhookRouteConnection {
  externalIntegrationUserLinkId: string;
  integrationClientId: string;
  provider: string;
  externalUserId: string;
  deliveryUrl: string;
  connectedAt: string;
  lastSyncedAt: string;
}
