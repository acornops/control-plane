import {
  createPasswordUser as createPasswordUserRecord,
  getAuthMethodsForUser as getAuthMethodsForUserRecord,
  getFederatedIdentityByProviderSubject as getFederatedIdentityByProviderSubjectRecord,
  getPasswordCredentialByIdentifier as getPasswordCredentialByIdentifierRecord,
  getPasswordCredentialByUserId as getPasswordCredentialByUserIdRecord,
  getUserById as getUserByIdRecord,
  getWorkspaceRole as getWorkspaceRoleRecord,
  getWorkspaceSummaryForUser as getWorkspaceSummaryForUserRecord,
  linkFederatedIdentity as linkFederatedIdentityRecord,
  listWorkspacesForUser as listWorkspacesForUserRecord,
  markFederatedIdentityLoginSuccess as markFederatedIdentityLoginSuccessRecord,
  markPasswordLoginSuccess as markPasswordLoginSuccessRecord,
  resolveOidcLogin as resolveOidcLoginRecord,
  updatePasswordCredentialHash as updatePasswordCredentialHashRecord,
  upsertUser as upsertUserRecord,
  userHasWorkspaceAccess as userHasWorkspaceAccessRecord,
  addWorkspace as addWorkspaceRecord
} from './repository-users.js';
import * as repositoryDevelopmentSeed from './repository-development-seed.js';
import { ensureOidcPrelinkedIdentities as ensureOidcPrelinkedIdentitiesRecord } from './repository-oidc-prelinks.js';
import {
  consumeEmailVerificationToken as consumeEmailVerificationTokenRecord,
  invalidateEmailVerificationToken as invalidateEmailVerificationTokenRecord,
  prepareEmailVerificationResend as prepareEmailVerificationResendRecord,
  retireOtherEmailVerificationTokens as retireOtherEmailVerificationTokensRecord
} from './repository-email-verifications.js';
import {
  consumePasswordResetToken as consumePasswordResetTokenRecord,
  getPasswordResetTokenContext as getPasswordResetTokenContextRecord,
  invalidatePasswordResetToken as invalidatePasswordResetTokenRecord,
  preparePasswordResetRequest as preparePasswordResetRequestRecord
} from './repository-password-resets.js';
import {
  addWorkspaceMember as addWorkspaceMemberRecord,
  deleteWorkspace as deleteWorkspaceRecord,
  deleteWorkspaceMember as deleteWorkspaceMemberRecord,
  getWorkspaceMember as getWorkspaceMemberRecord,
  listWorkspaceMembers as listWorkspaceMembersRecord,
  updateWorkspaceMemberRole as updateWorkspaceMemberRoleRecord
} from './repository-workspaces.js';
import {
  getWorkspaceAiSettings as getWorkspaceAiSettingsRecord,
  upsertWorkspaceAiSettings as upsertWorkspaceAiSettingsRecord
} from './repository-ai-settings.js';
import {
  acceptWorkspaceInvitation as acceptWorkspaceInvitationRecord,
  createWorkspaceInvitation as createWorkspaceInvitationRecord,
  getWorkspaceInvitationByTokenHash as getWorkspaceInvitationByTokenHashRecord,
  listWorkspaceInvitations as listWorkspaceInvitationsRecord,
  revokeWorkspaceInvitation as revokeWorkspaceInvitationRecord
} from './repository-invitations.js';
import {
  addCluster as addClusterRecord,
  deleteCluster as deleteClusterRecord,
  getCluster as getClusterRecord,
  getClusterSnapshot as getClusterSnapshotRecord,
  listClusters as listClustersRecord,
  updateCluster as updateClusterRecord,
  upsertClusterSnapshot as upsertClusterSnapshotRecord
} from './repository-kubernetes-clusters.js';
import {
  addVirtualMachine as addVirtualMachineRecord,
  deleteVirtualMachine as deleteVirtualMachineRecord,
  getVirtualMachine as getVirtualMachineRecord,
  getVirtualMachineSnapshot as getVirtualMachineSnapshotRecord,
  listVirtualMachineInventory as listVirtualMachineInventoryRecord,
  getVirtualMachineSnapshotSummary as getVirtualMachineSnapshotSummaryRecord,
  listVirtualMachineSnapshotSummaries as listVirtualMachineSnapshotSummariesRecord,
  listVirtualMachines as listVirtualMachinesRecord,
  updateVirtualMachine as updateVirtualMachineRecord,
  upsertVirtualMachineSnapshot as upsertVirtualMachineSnapshotRecord
} from './repository-virtual-machines.js';
import {
  getTargetAgentRegistration as getTargetAgentRegistrationRecord,
  listTargetAgentRegistrations as listTargetAgentRegistrationsRecord,
  listWorkspaceTargetAgentRegistrations as listWorkspaceTargetAgentRegistrationsRecord,
  rotateTargetAgentKey as rotateTargetAgentKeyRecord, updateTargetAgentCapabilities as updateTargetAgentCapabilitiesRecord,
  updateTargetAgentSeen as updateTargetAgentSeenRecord,
  upsertTargetAgentRegistration as upsertTargetAgentRegistrationRecord
} from './repository-target-agent-registrations.js';
import {
  getTargetToolSetting as getTargetToolSettingRecord,
  listEnabledTargetToolSettings as listEnabledTargetToolSettingsRecord,
  listTargetToolSettings as listTargetToolSettingsRecord,
  listTargetToolOverrides as listTargetToolOverridesRecord,
  setTargetToolOverride as setTargetToolOverrideRecord,
  upsertTargetToolSetting as upsertTargetToolSettingRecord
} from './repository-target-tools.js';
import * as repositoryTargetInsights from './repository-target-insights.js';
import * as repositoryTargetInsightsCheckpoints from './repository-target-insights-checkpoints.js';
import * as toolResultArtifacts from './repository-tool-result-artifacts.js';
import {
  countEnabledTargetSkills as countEnabledTargetSkillsRecord,
  createTargetSkill as createTargetSkillRecord,
  deleteTargetSkill as deleteTargetSkillRecord,
  getTargetSkill as getTargetSkillRecord,
  listEnabledValidTargetSkillSummaries as listEnabledValidTargetSkillSummariesRecord,
  listEnabledValidTargetSkills as listEnabledValidTargetSkillsRecord,
  listTargetSkills as listTargetSkillsRecord,
  updateTargetSkill as updateTargetSkillRecord,
  updateTargetSkillEnabled as updateTargetSkillEnabledRecord
} from './repository-target-skills.js';
import * as runSkillSnapshots from './repository-run-skill-snapshots.js';
import {
  getClusterSnapshotSummary as getClusterSnapshotSummaryRecord,
  listClusterSnapshotResources as listClusterSnapshotResourcesRecord,
  listClusterSnapshotSummaries as listClusterSnapshotSummariesRecord
} from './repository-kubernetes-inventory.js';
import {
  getTargetIssue as getTargetIssueRecord,
  listTargetIssueObservations as listTargetIssueObservationsRecord,
  listTargetIssues as listTargetIssuesRecord,
  listWorkspaceIssues as listWorkspaceIssuesRecord,
  summarizeTargetIssues as summarizeTargetIssuesRecord
} from './repository-target-issues.js';
import {
  addMessage as addMessageRecord,
  addRun as addRunRecord,
  addSession as addSessionRecord,
  appendRunEvents as appendRunEventsRecord,
  createRunFromUserMessage as createRunFromUserMessageRecord,
  deleteSession as deleteSessionRecord,
  findRunByClientMessageId as findRunByClientMessageIdRecord,
  getRun as getRunRecord,
  getRunEvents as getRunEventsRecord,
  getLatestRunEventSeq as getLatestRunEventSeqRecord,
  getSession as getSessionRecord,
  listMessages as listMessagesRecord,
  listSessionsByTarget as listSessionsByTargetRecord,
  purgeExpiredOrDeletedSessions as purgeExpiredOrDeletedSessionsRecord,
  updateMessageRunId as updateMessageRunIdRecord,
  updateRun as updateRunRecord,
  upsertAssistantFinalMessage as upsertAssistantFinalMessageRecord
} from './repository-sessions.js';
import {
  insertTargetChatActivityEvent as insertTargetChatActivityEventRecord,
  listRecentTargetChatActivity as listRecentTargetChatActivityRecord,
  listTargetChatActivityEvents as listTargetChatActivityEventsRecord
} from './repository-chat-activity.js';
import {
  countPendingWorkspaceRunToolApprovals as countPendingWorkspaceRunToolApprovalsRecord,
  createRunToolApproval as createRunToolApprovalRecord,
  decideRunToolApproval as decideRunToolApprovalRecord,
  deleteRunContinuation as deleteRunContinuationRecord,
  expirePendingRunToolApprovals as expirePendingRunToolApprovalsRecord,
  expireRunToolApproval as expireRunToolApprovalRecord,
  getRunContinuation as getRunContinuationRecord,
  getRunToolApproval as getRunToolApprovalRecord,
  listWorkspaceRunToolApprovals as listWorkspaceRunToolApprovalsRecord,
  listRunToolApprovals as listRunToolApprovalsRecord,
  markRunToolApprovalExecutionFinished as markRunToolApprovalExecutionFinishedRecord,
  startRunToolApprovalExecution as startRunToolApprovalExecutionRecord
} from './repository-run-approvals.js';
import {
  createWebhookSubscription as createWebhookSubscriptionRecord,
  connectExternalWebhookRoute as connectExternalWebhookRouteRecord,
  deleteWebhookSubscription as deleteWebhookSubscriptionRecord,
  getWebhookSubscription as getWebhookSubscriptionRecord,
  insertWebhookHistory as insertWebhookHistoryRecord,
  listMatchingWebhookSubscriptions as listMatchingWebhookSubscriptionsRecord,
  listWebhookSubscriptionsForExternalRoute as listWebhookSubscriptionsForExternalRouteRecord,
  listWebhookHistory as listWebhookHistoryRecord,
  listWebhookSubscriptions as listWebhookSubscriptionsRecord,
  purgeOldWebhookHistory as purgeOldWebhookHistoryRecord,
  touchExternalWebhookRouteConnection as touchExternalWebhookRouteConnectionRecord,
  updateWebhookSubscription as updateWebhookSubscriptionRecord
} from './repository-webhooks.js';
import {
  getTarget as getTargetRecord,
  listTargets as listTargetsRecord,
  listWorkflowTargetSnapshot as listWorkflowTargetSnapshotRecord
} from './repository-targets.js';
import {
  insertWorkspaceAuditEvent as insertWorkspaceAuditEventRecord,
  listWorkspaceAuditEvents as listWorkspaceAuditEventsRecord,
  purgeOldWorkspaceAuditEvents as purgeOldWorkspaceAuditEventsRecord
} from './repository-audit-events.js';
import {
  insertAdminAuditEvent as insertAdminAuditEventRecord,
  listAdminAuditEvents as listAdminAuditEventsRecord
} from './repository-admin-audit.js';
import {
  countWorkspaceUsage as countWorkspaceUsageRecord,
  addExistingWorkspaceMember as addExistingWorkspaceMemberRecord,
  deleteExistingWorkspaceMember as deleteExistingWorkspaceMemberRecord,
  createVerifiedInternalUser as createVerifiedInternalUserRecord,
  findUserByEmail as findUserByEmailRecord,
  getAdminUser as getAdminUserRecord,
  getAdminWorkspace as getAdminWorkspaceRecord,
  getTargetById as getTargetByIdRecord,
  listAdminRuns as listAdminRunsRecord,
  listAdminTargets as listAdminTargetsRecord,
  listAdminUsers as listAdminUsersRecord,
  listAdminWorkspaces as listAdminWorkspacesRecord,
  replaceLastOwnerAndDeleteMember as replaceLastOwnerAndDeleteMemberRecord,
  updateExistingWorkspaceMemberRole as updateExistingWorkspaceMemberRoleRecord,
  setWorkspaceQuotaOverrides as setWorkspaceQuotaOverridesRecord,
  updateWorkspacePlan as updateWorkspacePlanRecord
} from './repository-admin.js';
import {
  getRoleTemplate as getRoleTemplateRecord,
  listRoleTemplates as listRoleTemplatesRecord,
  syncRoleTemplates as syncRoleTemplatesRecord
} from './repository-role-templates.js';
import {
  completeExternalIntegrationLinkToken as completeExternalIntegrationLinkTokenRecord,
  createExternalIntegrationLinkToken as createExternalIntegrationLinkTokenRecord,
  getExternalIntegrationLinkTokenUser as getExternalIntegrationLinkTokenUserRecord,
  externalIntegrationLinkTokenIsPending as externalIntegrationLinkTokenIsPendingRecord,
  listExternalIntegrationUserLinks as listExternalIntegrationUserLinksRecord,
  listExternalIntegrationGrantableWorkspaces as listExternalIntegrationGrantableWorkspacesRecord,
  previewExternalIntegrationLinkToken as previewExternalIntegrationLinkTokenRecord,
  purgeOldExternalIntegrationLinkTokens as purgeOldExternalIntegrationLinkTokensRecord,
  getExternalIntegrationWorkspaceGrant as getExternalIntegrationWorkspaceGrantRecord,
  replaceExternalIntegrationWorkspaceGrants as replaceExternalIntegrationWorkspaceGrantsRecord,
  revokeExternalIntegrationUserLink as revokeExternalIntegrationUserLinkRecord,
  resolveExternalIntegrationUserLink as resolveExternalIntegrationUserLinkRecord
} from './repository-external-integration-links.js';
import {
  listTargetMetricHistory as listTargetMetricHistoryRecord,
  purgeOldTargetMetricHistory as purgeOldTargetMetricHistoryRecord
} from './repository-target-metrics.js';
import { insertAccountAuditEvent as insertAccountAuditEventRecord } from './repository-account-audit.js';
import { getUserQuotaForUser as getUserQuotaForUserRecord } from './repository-quotas.js';
export class Repository {
  upsertUser = upsertUserRecord;
  getUserById = getUserByIdRecord;
  getUserQuotaForUser = getUserQuotaForUserRecord;

  createPasswordUser = createPasswordUserRecord;

  consumeEmailVerificationToken = consumeEmailVerificationTokenRecord;

  invalidateEmailVerificationToken = invalidateEmailVerificationTokenRecord;

  retireOtherEmailVerificationTokens = retireOtherEmailVerificationTokensRecord;

  prepareEmailVerificationResend = prepareEmailVerificationResendRecord;

  preparePasswordResetRequest = preparePasswordResetRequestRecord;

  getPasswordResetTokenContext = getPasswordResetTokenContextRecord;

  consumePasswordResetToken = consumePasswordResetTokenRecord;

  invalidatePasswordResetToken = invalidatePasswordResetTokenRecord;

  getPasswordCredentialByIdentifier = getPasswordCredentialByIdentifierRecord;

  getPasswordCredentialByUserId = getPasswordCredentialByUserIdRecord;

  markPasswordLoginSuccess = markPasswordLoginSuccessRecord;

  updatePasswordCredentialHash = updatePasswordCredentialHashRecord;

  getAuthMethodsForUser = getAuthMethodsForUserRecord;

  getFederatedIdentityByProviderSubject = getFederatedIdentityByProviderSubjectRecord;

  markFederatedIdentityLoginSuccess = markFederatedIdentityLoginSuccessRecord;

  linkFederatedIdentity = linkFederatedIdentityRecord;

  resolveOidcLogin = resolveOidcLoginRecord;

  createExternalIntegrationLinkToken = createExternalIntegrationLinkTokenRecord;
  completeExternalIntegrationLinkToken = completeExternalIntegrationLinkTokenRecord;
  getExternalIntegrationLinkTokenUser = getExternalIntegrationLinkTokenUserRecord;
  externalIntegrationLinkTokenIsPending = externalIntegrationLinkTokenIsPendingRecord;
  previewExternalIntegrationLinkToken = previewExternalIntegrationLinkTokenRecord;
  resolveExternalIntegrationUserLink = resolveExternalIntegrationUserLinkRecord;
  listExternalIntegrationUserLinks = listExternalIntegrationUserLinksRecord;
  listExternalIntegrationGrantableWorkspaces = listExternalIntegrationGrantableWorkspacesRecord;
  getExternalIntegrationWorkspaceGrant = getExternalIntegrationWorkspaceGrantRecord;
  replaceExternalIntegrationWorkspaceGrants = replaceExternalIntegrationWorkspaceGrantsRecord;
  revokeExternalIntegrationUserLink = revokeExternalIntegrationUserLinkRecord;
  purgeOldExternalIntegrationLinkTokens = purgeOldExternalIntegrationLinkTokensRecord;

  insertAccountAuditEvent = insertAccountAuditEventRecord;

  addWorkspace = addWorkspaceRecord;

  listWorkspacesForUser = listWorkspacesForUserRecord;

  getWorkspaceSummaryForUser = getWorkspaceSummaryForUserRecord;

  userHasWorkspaceAccess = userHasWorkspaceAccessRecord;

  getWorkspaceRole = getWorkspaceRoleRecord;

  getWorkspaceAiSettings = getWorkspaceAiSettingsRecord;

  upsertWorkspaceAiSettings = upsertWorkspaceAiSettingsRecord;

  listWorkspaceMembers = listWorkspaceMembersRecord;

  getWorkspaceMember = getWorkspaceMemberRecord;

  addWorkspaceMember = addWorkspaceMemberRecord;

  createWorkspaceInvitation = createWorkspaceInvitationRecord;

  getWorkspaceInvitationByTokenHash = getWorkspaceInvitationByTokenHashRecord;

  listWorkspaceInvitations = listWorkspaceInvitationsRecord;

  revokeWorkspaceInvitation = revokeWorkspaceInvitationRecord;

  acceptWorkspaceInvitation = acceptWorkspaceInvitationRecord;

  updateWorkspaceMemberRole = updateWorkspaceMemberRoleRecord;

  deleteWorkspaceMember = deleteWorkspaceMemberRecord;

  addCluster = addClusterRecord;

  listClusters = listClustersRecord;

  listTargets = listTargetsRecord; listWorkflowTargetSnapshot = listWorkflowTargetSnapshotRecord;

  getTarget = getTargetRecord;

  getCluster = getClusterRecord;

  updateCluster = updateClusterRecord;

  deleteCluster = deleteClusterRecord;

  addVirtualMachine = addVirtualMachineRecord;

  listVirtualMachines = listVirtualMachinesRecord;

  getVirtualMachine = getVirtualMachineRecord;

  updateVirtualMachine = updateVirtualMachineRecord;

  deleteVirtualMachine = deleteVirtualMachineRecord;

  deleteWorkspace = deleteWorkspaceRecord;

  upsertTargetAgentRegistration = upsertTargetAgentRegistrationRecord;
  getTargetAgentRegistration = getTargetAgentRegistrationRecord;
  listTargetAgentRegistrations = listTargetAgentRegistrationsRecord;
  listWorkspaceTargetAgentRegistrations = listWorkspaceTargetAgentRegistrationsRecord;
  rotateTargetAgentKey = rotateTargetAgentKeyRecord;
  updateTargetAgentCapabilities = updateTargetAgentCapabilitiesRecord;
  updateTargetAgentSeen = updateTargetAgentSeenRecord;

  addSession = addSessionRecord;

  listSessionsByTarget = listSessionsByTargetRecord;

  listRecentTargetChatActivity = listRecentTargetChatActivityRecord;

  insertTargetChatActivityEvent = insertTargetChatActivityEventRecord;

  listTargetChatActivityEvents = listTargetChatActivityEventsRecord;

  getSession = getSessionRecord;

  deleteSession = deleteSessionRecord;

  purgeExpiredOrDeletedSessions = purgeExpiredOrDeletedSessionsRecord;


  addMessage = addMessageRecord;

  listMessages = listMessagesRecord;

  updateMessageRunId = updateMessageRunIdRecord;

  findRunByClientMessageId = findRunByClientMessageIdRecord;

  createRunFromUserMessage = createRunFromUserMessageRecord;

  upsertAssistantFinalMessage = upsertAssistantFinalMessageRecord;

  addRun = addRunRecord;

  getRun = getRunRecord;

  updateRun = updateRunRecord;

  appendRunEvents = appendRunEventsRecord;

  getRunEvents = getRunEventsRecord;

  getLatestRunEventSeq = getLatestRunEventSeqRecord;

  createRunToolApproval = createRunToolApprovalRecord;

  getRunToolApproval = getRunToolApprovalRecord;

  listRunToolApprovals = listRunToolApprovalsRecord;
  listWorkspaceRunToolApprovals = listWorkspaceRunToolApprovalsRecord;
  countPendingWorkspaceRunToolApprovals = countPendingWorkspaceRunToolApprovalsRecord;
  getRunContinuation = getRunContinuationRecord;

  deleteRunContinuation = deleteRunContinuationRecord;

  decideRunToolApproval = decideRunToolApprovalRecord;

  expireRunToolApproval = expireRunToolApprovalRecord;

  expirePendingRunToolApprovals = expirePendingRunToolApprovalsRecord;

  startRunToolApprovalExecution = startRunToolApprovalExecutionRecord;

  markRunToolApprovalExecutionFinished = markRunToolApprovalExecutionFinishedRecord;

  upsertClusterSnapshot = upsertClusterSnapshotRecord;

  getClusterSnapshot = getClusterSnapshotRecord;

  getClusterSnapshotSummary = getClusterSnapshotSummaryRecord;

  listClusterSnapshotSummaries = listClusterSnapshotSummariesRecord;

  listClusterSnapshotResources = listClusterSnapshotResourcesRecord;

  listWorkspaceIssues = listWorkspaceIssuesRecord;
  listTargetIssues = listTargetIssuesRecord;
  summarizeTargetIssues = summarizeTargetIssuesRecord;
  getTargetIssue = getTargetIssueRecord;
  listTargetIssueObservations = listTargetIssueObservationsRecord;

  listTargetMetricHistory = listTargetMetricHistoryRecord;

  purgeOldTargetMetricHistory = purgeOldTargetMetricHistoryRecord;

  upsertVirtualMachineSnapshot = upsertVirtualMachineSnapshotRecord;

  getVirtualMachineSnapshot = getVirtualMachineSnapshotRecord;

  getVirtualMachineSnapshotSummary = getVirtualMachineSnapshotSummaryRecord;

  listVirtualMachineSnapshotSummaries = listVirtualMachineSnapshotSummariesRecord;

  listVirtualMachineInventory = listVirtualMachineInventoryRecord;

  listTargetToolOverrides = listTargetToolOverridesRecord;
  setTargetToolOverride = setTargetToolOverrideRecord;
  listTargetToolSettings = listTargetToolSettingsRecord;
  getTargetToolSetting = getTargetToolSettingRecord;
  listEnabledTargetToolSettings = listEnabledTargetToolSettingsRecord;
  upsertTargetToolSetting = upsertTargetToolSettingRecord;
  listTargetInsightsEntries = repositoryTargetInsights.listTargetInsightsEntries;
  getTargetInsightsEntry = repositoryTargetInsights.getTargetInsightsEntry;
  createTargetInsightsEntry = repositoryTargetInsights.createTargetInsightsEntry;
  updateTargetInsightsEntry = repositoryTargetInsights.updateTargetInsightsEntry;
  resetTargetInsights = repositoryTargetInsights.resetTargetInsights;
  searchTargetInsightsSnippets = repositoryTargetInsights.searchTargetInsightsSnippets;
  upsertTargetInsightsCheckpointJobForSessionActivity = repositoryTargetInsightsCheckpoints.upsertTargetInsightsCheckpointJobForSessionActivity;
  claimDueTargetInsightsCheckpointJobs = repositoryTargetInsightsCheckpoints.claimDueTargetInsightsCheckpointJobs;
  rescheduleTargetInsightsCheckpointJob = repositoryTargetInsightsCheckpoints.rescheduleTargetInsightsCheckpointJob;
  finishTargetInsightsCheckpointJob = repositoryTargetInsightsCheckpoints.finishTargetInsightsCheckpointJob;
  renewTargetInsightsCheckpointJobLeaseIfCurrent = repositoryTargetInsightsCheckpoints.renewTargetInsightsCheckpointJobLeaseIfCurrent;
  requeueTargetInsightsPausedCheckpoints = repositoryTargetInsightsCheckpoints.requeueTargetInsightsPausedCheckpoints;

  listTargetSkills = listTargetSkillsRecord;

  getTargetSkill = getTargetSkillRecord;

  createTargetSkill = createTargetSkillRecord;

  updateTargetSkill = updateTargetSkillRecord;
  updateTargetSkillEnabled = updateTargetSkillEnabledRecord;

  deleteTargetSkill = deleteTargetSkillRecord;
  countEnabledTargetSkills = countEnabledTargetSkillsRecord;
  listEnabledValidTargetSkills = listEnabledValidTargetSkillsRecord;
  listEnabledValidTargetSkillSummaries = listEnabledValidTargetSkillSummariesRecord;
  createRunSkillSnapshot = runSkillSnapshots.createRunSkillSnapshot;
  getRunSkillCatalog = runSkillSnapshots.getRunSkillCatalog;
  getRunSkillSnapshot = runSkillSnapshots.getRunSkillSnapshot;
  purgeOrphanedSkillSnapshotBlobs = runSkillSnapshots.purgeOrphanedSkillSnapshotBlobs;
  upsertToolResultArtifact = toolResultArtifacts.upsertToolResultArtifact;
  getToolResultArtifact = toolResultArtifacts.getToolResultArtifact;
  purgeExpiredToolResultArtifacts = toolResultArtifacts.purgeExpiredToolResultArtifacts;
  createWebhookSubscription = createWebhookSubscriptionRecord;
  connectExternalWebhookRoute = connectExternalWebhookRouteRecord;
  listWebhookSubscriptions = listWebhookSubscriptionsRecord;
  getWebhookSubscription = getWebhookSubscriptionRecord;
  updateWebhookSubscription = updateWebhookSubscriptionRecord;
  deleteWebhookSubscription = deleteWebhookSubscriptionRecord;
  listMatchingWebhookSubscriptions = listMatchingWebhookSubscriptionsRecord;
  listWebhookSubscriptionsForExternalRoute = listWebhookSubscriptionsForExternalRouteRecord;
  touchExternalWebhookRouteConnection = touchExternalWebhookRouteConnectionRecord;
  insertWebhookHistory = insertWebhookHistoryRecord;
  listWebhookHistory = listWebhookHistoryRecord;
  purgeOldWebhookHistory = purgeOldWebhookHistoryRecord;

  insertWorkspaceAuditEvent = insertWorkspaceAuditEventRecord;

  listWorkspaceAuditEvents = listWorkspaceAuditEventsRecord;

  purgeOldWorkspaceAuditEvents = purgeOldWorkspaceAuditEventsRecord;

  insertAdminAuditEvent = insertAdminAuditEventRecord;

  listAdminAuditEvents = listAdminAuditEventsRecord;

  listAdminWorkspaces = listAdminWorkspacesRecord;

  getAdminWorkspace = getAdminWorkspaceRecord;

  updateWorkspacePlan = updateWorkspacePlanRecord;

  setWorkspaceQuotaOverrides = setWorkspaceQuotaOverridesRecord;

  countWorkspaceUsage = countWorkspaceUsageRecord;

  addExistingWorkspaceMember = addExistingWorkspaceMemberRecord;

  updateExistingWorkspaceMemberRole = updateExistingWorkspaceMemberRoleRecord;

  deleteExistingWorkspaceMember = deleteExistingWorkspaceMemberRecord;

  listAdminUsers = listAdminUsersRecord;

  getAdminUser = getAdminUserRecord;

  findUserByEmail = findUserByEmailRecord;

  createVerifiedInternalUser = createVerifiedInternalUserRecord;

  replaceLastOwnerAndDeleteMember = replaceLastOwnerAndDeleteMemberRecord;

  listAdminTargets = listAdminTargetsRecord;

  getTargetById = getTargetByIdRecord;

  listAdminRuns = listAdminRunsRecord;

  syncRoleTemplates = syncRoleTemplatesRecord;

  listRoleTemplates = listRoleTemplatesRecord;

  getRoleTemplate = getRoleTemplateRecord;
  ensureDevelopmentTargetSeed = repositoryDevelopmentSeed.ensureDevelopmentTargetSeed;
  ensureOidcPrelinkedIdentities = ensureOidcPrelinkedIdentitiesRecord;
}

export const repo = new Repository();
