import {
  CategoryExpertise,
  CategoryExpertiseBreakdown,
  ExpertiseCategory,
  ExpertiseTier,
} from './entities/user-reputation.entity';
import { DAY_MS } from './utc-date';

export { DAY_MS, startOfUtcDay, toUtcDateString } from './utc-date';

/**
 * Pure, deterministic reputation math for BE-032. No I/O lives here so that
 * the nightly job and the simulation tests share the exact same formulas.
 */

export const REPUTATION_HALF_LIFE_DAYS = 90;
const SCORE_DECIMALS = 4;

/** Keyword table shared by the SQL classifier and the TS classifier. Order = precedence. */
export const CATEGORY_KEYWORDS: ReadonlyArray<[ExpertiseCategory, string[]]> = [
  [
    ExpertiseCategory.MEMECOINS,
    [
      'meme',
      'memecoin',
      'doge',
      'dogecoin',
      'shib',
      'pepe',
      'bonk',
      'wif',
      'floki',
    ],
  ],
  [
    ExpertiseCategory.AI,
    [
      'ai',
      'agi',
      'openai',
      'gpt',
      'llm',
      'nvidia',
      'nvda',
      'fet',
      'render',
      'tao',
    ],
  ],
  [
    ExpertiseCategory.DEFI,
    [
      'defi',
      'tvl',
      'aave',
      'uniswap',
      'uni',
      'curve',
      'lido',
      'maker',
      'dex',
      'yield',
      'lending',
      'amm',
      'soroswap',
      'blend',
      'aqua',
    ],
  ],
  [
    ExpertiseCategory.MACRO,
    [
      'fed',
      'fomc',
      'cpi',
      'inflation',
      'rates',
      'recession',
      'gdp',
      'election',
      'etf',
      'sp500',
      'nasdaq',
      'dxy',
      'gold',
      'oil',
      'macro',
    ],
  ],
];

const CATEGORY_MATCHERS: ReadonlyArray<[ExpertiseCategory, RegExp]> =
  CATEGORY_KEYWORDS.map(([category, words]) => [
    category,
    new RegExp(`\\b(${words.join('|')})\\b`, 'i'),
  ]);

const KNOWN_CATEGORIES = new Set<string>(Object.values(ExpertiseCategory));

export function normalizeCategory(
  raw: string | null | undefined,
): ExpertiseCategory | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  return KNOWN_CATEGORIES.has(upper) ? (upper as ExpertiseCategory) : null;
}

/** Classifies a call title when no explicit category was set. */
export function classifyCategory(
  title: string | null | undefined,
): ExpertiseCategory {
  if (!title) return ExpertiseCategory.OTHER;
  for (const [category, matcher] of CATEGORY_MATCHERS) {
    if (matcher.test(title)) return category;
  }
  return ExpertiseCategory.OTHER;
}

/**
 * SQL expression equivalent to `COALESCE(normalizeCategory(category), classifyCategory(title))`.
 * Uses Postgres word boundaries (\m, \M). Keywords are static so inlining is safe.
 */
export function categorySqlExpression(alias = 'c'): string {
  const known = Object.values(ExpertiseCategory)
    .map((v) => `'${v}'`)
    .join(', ');
  const branches = CATEGORY_KEYWORDS.map(
    ([category, words]) =>
      `WHEN ${alias}.title ~* '\\m(${words.join('|')})\\M' THEN '${category}'`,
  ).join(' ');
  return `CASE WHEN UPPER(${alias}.category) IN (${known}) THEN UPPER(${alias}.category) ${branches} ELSE '${ExpertiseCategory.OTHER}' END`;
}

export function round(value: number, decimals = SCORE_DECIMALS): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Whole-days-precision idle time; negative values (future activity) clamp to 0. */
export function idleDays(lastActiveAt: Date | null, asOf: Date): number {
  if (!lastActiveAt) return Infinity;
  return Math.max(0, (asOf.getTime() - lastActiveAt.getTime()) / DAY_MS);
}

/** Exponential half-life decay: 0.5 ^ (idle / halfLife). */
export function decayFactor(
  idle: number,
  halfLifeDays = REPUTATION_HALF_LIFE_DAYS,
): number {
  if (!Number.isFinite(idle)) return 0;
  if (idle <= 0) return 1;
  return Math.pow(0.5, idle / halfLifeDays);
}

/** Thin-sample penalty: 30% at 0 resolved calls, linear to 100% at 10. */
export function confidenceMultiplier(resolvedCalls: number): number {
  if (resolvedCalls <= 0) return 0;
  return resolvedCalls >= 10 ? 1 : 0.3 + (resolvedCalls / 10) * 0.7;
}

/** Log-scaled volume relative to the heaviest staker in the same bucket, 0–1. */
export function volumeWeight(volume: number, maxVolume: number): number {
  if (volume <= 0 || maxVolume <= 0) return 0;
  return Math.min(1, Math.log10(1 + volume) / Math.log10(1 + maxVolume));
}

export function tierFor(score: number, resolvedCalls: number): ExpertiseTier {
  if (score >= 80 && resolvedCalls >= 25) return ExpertiseTier.GRANDMASTER;
  if (score >= 60 && resolvedCalls >= 10) return ExpertiseTier.EXPERT;
  if (score >= 40) return ExpertiseTier.SKILLED;
  if (score >= 20) return ExpertiseTier.APPRENTICE;
  return ExpertiseTier.NOVICE;
}

export interface BucketStats {
  resolvedCalls: number;
  wins: number;
  /** Decimal string straight from Postgres to avoid float drift in storage. */
  volume: string;
  lastActiveAt: Date | null;
}

export function scoreBucket(
  stats: BucketStats,
  maxVolume: number,
  asOf: Date,
): CategoryExpertise & { decayFactor: number } {
  const winRate =
    stats.resolvedCalls > 0 ? stats.wins / stats.resolvedCalls : 0;
  const vw = volumeWeight(Number(stats.volume), maxVolume);
  const rawScore =
    100 *
    (0.7 * winRate + 0.3 * vw) *
    confidenceMultiplier(stats.resolvedCalls);
  const factor = decayFactor(idleDays(stats.lastActiveAt, asOf));
  const score = round(rawScore * factor);
  return {
    resolvedCalls: stats.resolvedCalls,
    wins: stats.wins,
    winRate: round(winRate),
    volume: stats.volume,
    volumeWeight: round(vw),
    rawScore: round(rawScore),
    score,
    tier: tierFor(score, stats.resolvedCalls),
    decayFactor: factor,
  };
}

export interface UserCategoryRow extends BucketStats {
  category: ExpertiseCategory;
}

export interface ComputedReputation {
  basePoints: number;
  decayedPoints: number;
  decayFactor: number;
  lastActiveAt: Date | null;
  categoryScores: CategoryExpertiseBreakdown;
  topCategory: ExpertiseCategory | null;
}

/** Adds two non-negative decimal strings without going through floats. */
export function addDecimalStrings(a: string, b: string): string {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const sum =
    BigInt(ai + af.padEnd(scale, '0')) + BigInt(bi + bf.padEnd(scale, '0'));
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/**
 * Combines one user's per-category rows into the overall decayed reputation
 * and the JSONB category breakdown.
 */
export function computeUserReputation(
  rows: UserCategoryRow[],
  maxVolumeByCategory: Map<ExpertiseCategory, number>,
  maxOverallVolume: number,
  asOf: Date,
): ComputedReputation {
  const categoryScores: CategoryExpertiseBreakdown = {};
  let resolved = 0;
  let wins = 0;
  let volume = '0';
  let lastActiveAt: Date | null = null;
  let topCategory: ExpertiseCategory | null = null;
  let topScore = -1;

  // Sorted so ties on topCategory resolve identically across runs.
  const ordered = [...rows].sort((a, b) =>
    a.category.localeCompare(b.category),
  );
  for (const row of ordered) {
    const { decayFactor: _decay, ...expertise } = scoreBucket(
      row,
      maxVolumeByCategory.get(row.category) ?? 0,
      asOf,
    );
    void _decay; // per-category factor is already folded into `score`
    categoryScores[row.category] = expertise;
    if (expertise.score > topScore) {
      topScore = expertise.score;
      topCategory = row.category;
    }
    resolved += row.resolvedCalls;
    wins += row.wins;
    volume = addDecimalStrings(volume, row.volume);
    if (
      row.lastActiveAt &&
      (!lastActiveAt || row.lastActiveAt > lastActiveAt)
    ) {
      lastActiveAt = row.lastActiveAt;
    }
  }

  const overall = scoreBucket(
    { resolvedCalls: resolved, wins, volume, lastActiveAt },
    maxOverallVolume,
    asOf,
  );

  return {
    basePoints: overall.rawScore,
    decayedPoints: overall.score,
    decayFactor: round(overall.decayFactor, 8),
    lastActiveAt,
    categoryScores,
    topCategory: topScore > 0 ? topCategory : null,
  };
}
