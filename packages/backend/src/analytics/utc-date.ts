/** UTC calendar-day helpers shared by the nightly analytics jobs. */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** YYYY-MM-DD of the UTC day containing `date`. */
export function toUtcDateString(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}
