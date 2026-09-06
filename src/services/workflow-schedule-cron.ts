import { CronExpressionParser } from 'cron-parser';

// Keep the existing numeric, minute-resolution contract; parser extensions such
// as seconds, aliases, and hashed/random fields are intentionally not exposed.
const cronFieldPattern = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\d+(?:-\d+)?)(?:\/\d+)?)*$/;

export class WorkflowScheduleCadenceError extends Error {
  constructor() {
    super('This schedule has no future occurrence. Review its cron expression and timezone.');
    this.name = 'WorkflowScheduleCadenceError';
  }
}

export function requireWorkflowScheduleNextRun(expression: string, from: Date, timezone: string): string {
  const next = computeNextWorkflowScheduleRunAt(expression, from, timezone);
  if (!next) throw new WorkflowScheduleCadenceError();
  return next;
}

function parseSchedule(expression: string, from: Date, timezone: string) {
  const fields = expression.trim().split(/\s+/);
  if (expression.length > 256 || fields.length !== 5 || !fields.every((field) => cronFieldPattern.test(field))
    || !(expression.match(/\d+/g) || []).every((value) => Number.isSafeInteger(Number(value)))) {
    throw new Error('Use a numeric five-field cron expression.');
  }
  // One Gregorian cycle covers every numeric month/day/weekday combination,
  // including leap-day weekday intersections across non-leap centuries.
  const endDate = new Date(from);
  endDate.setUTCFullYear(endDate.getUTCFullYear() + 400);
  const options = { currentDate: from, endDate, tz: timezone };
  const original = CronExpressionParser.parse(fields.join(' '), options);
  // Vixie cron intersects the day fields when either starts with '*', including
  // steps/lists. Generate month-day candidates and filter weekdays separately:
  // this keeps calendar jumps and immediately rejects impossible month-days.
  if (fields[2].startsWith('*') || fields[4].startsWith('*')) {
    const weekdays = original.fields.dayOfWeek.values;
    fields[4] = '*';
    return { iterator: CronExpressionParser.parse(fields.join(' '), options), weekdays };
  }
  return { iterator: original, weekdays: null };
}

function nextCalendarOccurrence(expression: string, from: Date, timezone: string): Date | undefined {
  const { iterator, weekdays } = parseSchedule(expression, from, timezone);
  for (let skippedDays = 0; skippedDays <= 400 * 366; skippedDays += 1) {
    const candidate = iterator.next();
    const weekday = candidate.getDay();
    if (!weekdays || weekdays.some((day) => day === weekday || (weekday === 0 && day === 7))) {
      return candidate.toDate();
    }
    // Public timezone-aware operations skip every remaining minute of this
    // rejected local day, including short/long DST days. The original horizon
    // remains fixed while the parser continues to jump calendar fields.
    candidate.setEndOfDay();
    iterator.reset(candidate);
  }
  return undefined;
}

export function validateWorkflowScheduleCron(expression: string): boolean {
  try {
    parseSchedule(expression, new Date('2024-01-01T00:00:00Z'), 'UTC');
    return true;
  } catch {
    return false;
  }
}

export function validateWorkflowScheduleTimezone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function computeUpcomingWorkflowScheduleRuns(
  expression: string,
  timezone: string,
  count = 5,
  from = new Date()
): string[] {
  if (!validateWorkflowScheduleTimezone(timezone) || !Number.isFinite(from.getTime())) return [];
  const runs: string[] = [];
  try {
    let cursor = from;
    // Reset the horizon for each occurrence, including successive leap days.
    const limit = Number.isFinite(count) ? Math.max(1, Math.min(10, Math.floor(count))) : 5;
    for (let index = 0; index < limit; index += 1) {
      const next = nextCalendarOccurrence(expression, cursor, timezone);
      if (!next) break;
      runs.push(next.toISOString());
      cursor = next;
    }
  } catch {
    // Invalid dates and exhausted bounded searches do not invent an occurrence.
  }
  return runs;
}

export function computeNextWorkflowScheduleRunAt(expression: string, from = new Date(), timezone = 'UTC'): string | undefined {
  return computeUpcomingWorkflowScheduleRuns(expression, timezone, 1, from)[0];
}

export function summarizeWorkflowScheduleCron(expression: string, timezone: string): string {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  const fallback = `Cron ${expression.trim()} (${timezone})`;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || !validateWorkflowScheduleCron(expression)) return fallback;
  const time = `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
  if (day === '*' && month === '*' && weekday === '*') return `Every day at ${time} (${timezone})`;
  if (day === '*' && month === '*' && weekday === '1-5') return `Weekdays at ${time} (${timezone})`;
  if (day === '*' && month === '*' && /^\d$/.test(weekday)) return `Weekly at ${time} (${timezone})`;
  if (day === '*' && month === '*' && /^\d(?:,\d)+$/.test(weekday)) return `Selected weekdays at ${time} (${timezone})`;
  return fallback;
}
