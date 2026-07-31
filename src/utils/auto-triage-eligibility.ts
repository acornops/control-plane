import type { TargetAutoTriageSettings } from '../types/auto-triage.js';
import type { TargetIssue } from '../types/target-issues.js';

type EligibleIssueFields = Pick<
  TargetIssue,
  'targetType' | 'severity' | 'scopeKind' | 'scopeName'
>;

function severityRank(severity: TargetIssue['severity']): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

export function issueMeetsAutoTriageThreshold(
  issueSeverity: TargetIssue['severity'],
  minimumSeverity: TargetIssue['severity']
): boolean {
  return severityRank(issueSeverity) <= severityRank(minimumSeverity);
}

export function issueMatchesAutoTriageScope(
  issue: Pick<EligibleIssueFields, 'targetType' | 'scopeKind' | 'scopeName'>,
  settings: Pick<
    TargetAutoTriageSettings,
    'namespaceInclude' | 'namespaceExclude' | 'includeClusterScopedIssues'
  >
): boolean {
  if (issue.targetType !== 'kubernetes') return true;
  const namespace = issue.scopeKind?.toLowerCase() === 'namespace'
    ? issue.scopeName?.trim()
    : undefined;
  if (!namespace) return settings.includeClusterScopedIssues !== false;
  const namespaceExclude = settings.namespaceExclude || [];
  const namespaceInclude = settings.namespaceInclude || [];
  if (namespaceExclude.includes(namespace)) return false;
  return namespaceInclude.length === 0 || namespaceInclude.includes(namespace);
}

export function issueMeetsAutoTriageEligibility(
  issue: EligibleIssueFields,
  settings: Pick<
    TargetAutoTriageSettings,
    | 'minimumSeverity'
    | 'namespaceInclude'
    | 'namespaceExclude'
    | 'includeClusterScopedIssues'
  >
): boolean {
  return (
    issueMeetsAutoTriageThreshold(issue.severity, settings.minimumSeverity)
    && issueMatchesAutoTriageScope(issue, settings)
  );
}
