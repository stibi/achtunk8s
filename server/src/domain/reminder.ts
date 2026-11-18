/** The furthest ahead a reminder can be set (ADR 0025). */
export const longestReminderMs = 365 * 24 * 60 * 60 * 1000;

/**
 * Why a reminder can't be set for `remindAt` at `now`, or null when it can: it must be in
 * the future, and no more than `longestReminderMs` ahead.
 */
export function reminderProblem(remindAt: Date, now: Date): string | null {
  if (remindAt <= now) {
    return "A reminder must be in the future";
  }
  if (remindAt.getTime() - now.getTime() > longestReminderMs) {
    return "A reminder can be at most a year ahead";
  }
  return null;
}
