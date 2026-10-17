/**
 * Pure helpers for bucketed protocol time series (BE-033): window
 * resolution, bucket labelling/filling, growth metrics and exact decimal
 * arithmetic on the numeric strings Postgres returns.
 */

export type BucketInterval = 'hour' | 'day';
export type TimeseriesRange = '24h' | '7d' | '30d' | '90d' | '1y';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RANGE_MS: Record<TimeseriesRange, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  '1y': 365 * DAY_MS,
};

export const DEFAULT_INTERVAL: Record<TimeseriesRange, BucketInterval> = {
  '24h': 'hour',
  '7d': 'hour',
  '30d': 'day',
  '90d': 'day',
  '1y': 'day',
};

/** Hard cap so a request can never ask Postgres for an unbounded series. */
export const MAX_BUCKETS = 24 * 31;

export const INTERVAL_MS: Record<BucketInterval, number> = {
  hour: HOUR_MS,
  day: DAY_MS,
};

export function isRange(v: unknown): v is TimeseriesRange {
  return typeof v === 'string' && v in RANGE_MS;
}

export function isInterval(v: unknown): v is BucketInterval {
  return v === 'hour' || v === 'day';
}

/** Equivalent of Postgres date_trunc for UTC timestamps. */
export function truncateUtc(date: Date, interval: BucketInterval): Date {
  const d = new Date(date.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (interval === 'day') d.setUTCHours(0);
  return d;
}

export interface TimeseriesWindow {
  range: TimeseriesRange;
  interval: BucketInterval;
  /** Inclusive start of the first bucket. */
  from: Date;
  /** Exclusive end: the end of the current (partial) bucket. */
  to: Date;
  /** Previous window of equal length, for growth comparisons. */
  previousFrom: Date;
  bucketCount: number;
}

/**
 * Resolves a range + interval into aligned bucket boundaries. The current
 * bucket is included (partially filled) so charts end at "now".
 */
export function resolveWindow(
  range: TimeseriesRange,
  interval: BucketInterval = DEFAULT_INTERVAL[range],
  now: Date = new Date(),
): TimeseriesWindow {
  const step = INTERVAL_MS[interval];
  const to = new Date(truncateUtc(now, interval).getTime() + step);
  let bucketCount = Math.ceil(RANGE_MS[range] / step);
  if (bucketCount > MAX_BUCKETS) {
    throw new RangeError(
      `${range} at ${interval} resolution exceeds ${MAX_BUCKETS} buckets`,
    );
  }
  bucketCount = Math.max(bucketCount, 1);
  const from = new Date(to.getTime() - bucketCount * step);
  const previousFrom = new Date(from.getTime() - bucketCount * step);
  return { range, interval, from, to, previousFrom, bucketCount };
}

/** ISO labels for every bucket start in [from, to). */
export function bucketLabels(window: TimeseriesWindow): string[] {
  const step = INTERVAL_MS[window.interval];
  return Array.from({ length: window.bucketCount }, (_, i) =>
    new Date(window.from.getTime() + i * step).toISOString(),
  );
}

/** Postgres-side label expression matching `bucketLabels` exactly. */
export function sqlBucketLabel(expr: string): string {
  return `to_char(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')`;
}

/**
 * Formats a Date as a zone-less UTC literal for `::timestamp` parameters, so
 * comparisons against `timestamp without time zone` columns never depend on
 * the Node or Postgres session time zone.
 */
export function toUtcTimestampLiteral(date: Date): string {
  return date.toISOString().replace('Z', '');
}

/** Projects sparse `{label → value}` rows onto the full label axis. */
export function fillSeries<T>(
  labels: string[],
  rows: Map<string, T>,
  empty: T,
): T[] {
  return labels.map((l) => rows.get(l) ?? empty);
}

// ─── exact decimal strings ────────────────────────────────────────────────

const SCALE = 7;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** Parses a (possibly negative) decimal string into fixed-point units of 1e-7. */
export function toUnits(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  const str = typeof value === 'number' ? value.toFixed(SCALE) : value.trim();
  const negative = str.startsWith('-');
  const [int, frac = ''] = (negative ? str.slice(1) : str).split('.');
  const units =
    BigInt(int || '0') * SCALE_FACTOR +
    BigInt((frac + '0'.repeat(SCALE)).slice(0, SCALE) || '0');
  return negative ? -units : units;
}

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const int = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${int}.${frac}`;
}

export function normalizeDecimal(value: string | null | undefined): string {
  return fromUnits(toUnits(value));
}

/**
 * Percentage change from `previous` to `current`, rounded to 2dp.
 * Null when there is no baseline (previous = 0) to compare against.
 */
export function growthPct(
  current: string | number,
  previous: string | number,
): number | null {
  const cur = toUnits(current);
  const prev = toUnits(previous);
  if (prev === 0n) return null;
  // Basis points of a percent via integer math, then one float division.
  const hundredths = ((cur - prev) * 10_000n) / (prev < 0n ? -prev : prev);
  return Number(hundredths) / 100;
}

/** Share of `part` in `total` as a percentage, 2dp. */
export function sharePct(part: string, total: string): number {
  const t = toUnits(total);
  if (t === 0n) return 0;
  return Number((toUnits(part) * 10_000n) / t) / 100;
}

// ─── fee split ────────────────────────────────────────────────────────────

export interface FeeSplitBps {
  treasury: number;
  creator: number;
  buyback: number;
  burn: number;
}

/** Mirrors the governance contract's default split (treasury.rs). */
export const DEFAULT_FEE_SPLIT_BPS: FeeSplitBps = {
  treasury: 5_000,
  creator: 2_500,
  buyback: 1_500,
  burn: 1_000,
};

/** Parses "treasury,creator,buyback,burn" bps; falls back to the default unless it sums to 10000. */
export function parseFeeSplit(raw: string | undefined): FeeSplitBps {
  if (!raw) return DEFAULT_FEE_SPLIT_BPS;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0) ||
    parts.reduce((a, b) => a + b, 0) !== 10_000
  ) {
    return DEFAULT_FEE_SPLIT_BPS;
  }
  const [treasury, creator, buyback, burn] = parts;
  return { treasury, creator, buyback, burn };
}

export interface FeeSplitAmounts {
  total: string;
  treasury: string;
  creator: string;
  buyback: string;
  burn: string;
}

/**
 * Splits a fee amount by bps without losing dust: each share is floored to
 * 1e-7 and the remainder goes to burn, so the parts always sum to the total.
 */
export function splitFee(
  total: string,
  bps: FeeSplitBps = DEFAULT_FEE_SPLIT_BPS,
): FeeSplitAmounts {
  const units = toUnits(total);
  const share = (b: number) => (units * BigInt(b)) / 10_000n;
  const treasury = share(bps.treasury);
  const creator = share(bps.creator);
  const buyback = share(bps.buyback);
  const burn = units - treasury - creator - buyback;
  return {
    total: fromUnits(units),
    treasury: fromUnits(treasury),
    creator: fromUnits(creator),
    buyback: fromUnits(buyback),
    burn: fromUnits(burn),
  };
}
