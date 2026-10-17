import {
  ExpertiseCategory,
  ExpertiseTier,
} from './entities/user-reputation.entity';
import {
  addDecimalStrings,
  categorySqlExpression,
  classifyCategory,
  computeUserReputation,
  confidenceMultiplier,
  DAY_MS,
  decayFactor,
  idleDays,
  normalizeCategory,
  REPUTATION_HALF_LIFE_DAYS,
  scoreBucket,
  round,
  tierFor,
  UserCategoryRow,
  volumeWeight,
} from './reputation-math';

const AS_OF = new Date('2026-10-18T00:00:00.000Z');
const daysAgo = (n: number) => new Date(AS_OF.getTime() - n * DAY_MS);

describe('reputation-math (BE-032)', () => {
  describe('half-life decay', () => {
    it('is 1 for active users and halves every 90 days', () => {
      expect(decayFactor(0)).toBe(1);
      expect(decayFactor(REPUTATION_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 12);
      expect(decayFactor(180)).toBeCloseTo(0.25, 12);
      expect(decayFactor(270)).toBeCloseTo(0.125, 12);
      expect(decayFactor(45)).toBeCloseTo(Math.SQRT1_2, 12);
    });

    it('treats never-active users as fully decayed and clamps future activity', () => {
      expect(decayFactor(idleDays(null, AS_OF))).toBe(0);
      expect(idleDays(new Date(AS_OF.getTime() + DAY_MS), AS_OF)).toBe(0);
    });

    it('is monotonically non-increasing in idle time', () => {
      let prev = Infinity;
      for (let d = 0; d <= 720; d += 7) {
        const f = decayFactor(d);
        expect(f).toBeLessThanOrEqual(prev);
        prev = f;
      }
    });

    it('composes: decaying 30d then 60d equals decaying 90d', () => {
      expect(decayFactor(30) * decayFactor(60)).toBeCloseTo(
        decayFactor(90),
        12,
      );
    });
  });

  describe('category classification', () => {
    it.each([
      ['Will DOGE flip $1 by Friday?', ExpertiseCategory.MEMECOINS],
      ['Will Aave TVL exceed $20B?', ExpertiseCategory.DEFI],
      ['Will OpenAI ship GPT-6 in 2026?', ExpertiseCategory.AI],
      ['Will the Fed cut rates in December?', ExpertiseCategory.MACRO],
      ['Will XLM close above 0.50?', ExpertiseCategory.OTHER],
      ['', ExpertiseCategory.OTHER],
    ])('%s → %s', (title, expected) => {
      expect(classifyCategory(title)).toBe(expected);
    });

    it('matches whole words only', () => {
      // "said" contains "ai" but is not an AI call.
      expect(classifyCategory('He said XLM pumps')).toBe(
        ExpertiseCategory.OTHER,
      );
    });

    it('normalises explicit categories case-insensitively and rejects unknowns', () => {
      expect(normalizeCategory('defi')).toBe(ExpertiseCategory.DEFI);
      expect(normalizeCategory(' Ai ')).toBe(ExpertiseCategory.AI);
      expect(normalizeCategory('sports')).toBeNull();
      expect(normalizeCategory(null)).toBeNull();
    });

    it('emits a SQL CASE that prefers explicit categories and uses PG word boundaries', () => {
      const sql = categorySqlExpression('c');
      expect(sql.startsWith('CASE WHEN UPPER(c.category) IN (')).toBe(true);
      expect(sql).toContain(`c.title ~* '\\m(meme|`);
      expect(sql.indexOf("THEN 'MEMECOINS'")).toBeLessThan(
        sql.indexOf("THEN 'DEFI'"),
      );
      expect(sql.trim().endsWith("ELSE 'OTHER' END")).toBe(true);
    });
  });

  describe('scoring primitives', () => {
    it('penalises thin samples and caps volume weight at 1', () => {
      expect(confidenceMultiplier(0)).toBe(0);
      expect(confidenceMultiplier(5)).toBeCloseTo(0.65, 12);
      expect(confidenceMultiplier(50)).toBe(1);
      expect(volumeWeight(0, 100)).toBe(0);
      expect(volumeWeight(100, 100)).toBe(1);
      expect(volumeWeight(1000, 100)).toBe(1);
      expect(volumeWeight(9, 99)).toBeCloseTo(0.5, 12);
    });

    it('gates top tiers on sample size', () => {
      expect(tierFor(95, 30)).toBe(ExpertiseTier.GRANDMASTER);
      expect(tierFor(95, 12)).toBe(ExpertiseTier.EXPERT);
      expect(tierFor(95, 3)).toBe(ExpertiseTier.SKILLED);
      expect(tierFor(25, 3)).toBe(ExpertiseTier.APPRENTICE);
      expect(tierFor(5, 100)).toBe(ExpertiseTier.NOVICE);
    });

    it('adds decimal strings exactly', () => {
      expect(addDecimalStrings('0.1', '0.2')).toBe('0.3');
      expect(addDecimalStrings('123.4500000', '0.0000001')).toBe('123.4500001');
      expect(addDecimalStrings('99999999999999999.9999999', '0.0000001')).toBe(
        '100000000000000000.0000000',
      );
      expect(addDecimalStrings('0', '5')).toBe('5');
      expect(addDecimalStrings('0.05', '0.05')).toBe('0.10');
    });

    it('rounds to 4dp without float artefacts', () => {
      expect(round(0.12345678)).toBe(0.1235);
      expect(round(0.1 + 0.2)).toBe(0.3);
      expect(round(Number.NaN)).toBe(0);
    });
  });

  describe('simulation', () => {
    const maxByCategory = new Map<ExpertiseCategory, number>([
      [ExpertiseCategory.DEFI, 10_000],
      [ExpertiseCategory.MEMECOINS, 1_000],
    ]);

    const sharp: UserCategoryRow[] = [
      {
        category: ExpertiseCategory.DEFI,
        resolvedCalls: 30,
        wins: 24,
        volume: '10000',
        lastActiveAt: daysAgo(0),
      },
      {
        category: ExpertiseCategory.MEMECOINS,
        resolvedCalls: 10,
        wins: 3,
        volume: '50.5',
        lastActiveAt: daysAgo(0),
      },
    ];

    it('scores a sharp, active DeFi predictor as a DeFi grandmaster', () => {
      const rep = computeUserReputation(sharp, maxByCategory, 10_050.5, AS_OF);
      const defi = rep.categoryScores.DEFI!;
      // 100 * (0.7 * 0.8 + 0.3 * 1) * 1 = 86
      expect(defi.score).toBe(86);
      expect(defi.tier).toBe(ExpertiseTier.GRANDMASTER);
      expect(rep.topCategory).toBe(ExpertiseCategory.DEFI);
      expect(rep.categoryScores.MEMECOINS!.tier).toBe(ExpertiseTier.APPRENTICE);
      expect(rep.decayFactor).toBe(1);
      expect(rep.decayedPoints).toBe(rep.basePoints);
      expect(rep.categoryScores.DEFI!.volume).toBe('10000');
    });

    it('halves the same profile after exactly one half-life of inactivity', () => {
      const idle = sharp.map((r) => ({ ...r, lastActiveAt: daysAgo(90) }));
      const active = computeUserReputation(
        sharp,
        maxByCategory,
        10_050.5,
        AS_OF,
      );
      const decayed = computeUserReputation(
        idle,
        maxByCategory,
        10_050.5,
        AS_OF,
      );
      expect(decayed.basePoints).toBe(active.basePoints);
      expect(decayed.decayFactor).toBe(0.5);
      expect(decayed.decayedPoints).toBeCloseTo(active.basePoints / 2, 3);
      expect(decayed.categoryScores.DEFI!.score).toBe(43);
      expect(decayed.categoryScores.DEFI!.tier).toBe(ExpertiseTier.SKILLED);
    });

    it('decays each category by its own last activity', () => {
      const rows: UserCategoryRow[] = [
        { ...sharp[0], lastActiveAt: daysAgo(180) },
        { ...sharp[1], lastActiveAt: daysAgo(0) },
      ];
      const rep = computeUserReputation(rows, maxByCategory, 10_050.5, AS_OF);
      expect(rep.categoryScores.DEFI!.score).toBe(21.5);
      // Overall decay keys off the most recent activity in any category.
      expect(rep.decayFactor).toBe(1);
      expect(rep.lastActiveAt).toEqual(daysAgo(0));
    });

    it('is deterministic regardless of input row order', () => {
      const a = computeUserReputation(sharp, maxByCategory, 10_050.5, AS_OF);
      const b = computeUserReputation(
        [...sharp].reverse(),
        maxByCategory,
        10_050.5,
        AS_OF,
      );
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    it('gives users with no resolved calls zero reputation and no top category', () => {
      const rep = computeUserReputation(
        [
          {
            category: ExpertiseCategory.AI,
            resolvedCalls: 0,
            wins: 0,
            volume: '0',
            lastActiveAt: daysAgo(1),
          },
        ],
        new Map(),
        0,
        AS_OF,
      );
      expect(rep.decayedPoints).toBe(0);
      expect(rep.topCategory).toBeNull();
    });

    it('scores 100k synthetic users well under the 30s budget', () => {
      const categories = Object.values(ExpertiseCategory);
      const max = new Map(categories.map((c) => [c, 50_000]));
      let seed = 42;
      const rand = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
        return seed / 2 ** 31;
      };

      const started = Date.now();
      let checksum = 0;
      for (let u = 0; u < 100_000; u++) {
        const rows: UserCategoryRow[] = categories
          .slice(0, 1 + (u % categories.length))
          .map((category) => {
            const resolved = Math.floor(rand() * 40);
            return {
              category,
              resolvedCalls: resolved,
              wins: Math.floor(rand() * (resolved + 1)),
              volume: (rand() * 50_000).toFixed(7),
              lastActiveAt: daysAgo(Math.floor(rand() * 365)),
            };
          });
        checksum += computeUserReputation(
          rows,
          max,
          250_000,
          AS_OF,
        ).decayedPoints;
      }
      const elapsed = Date.now() - started;

      expect(checksum).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(30_000);
    });
  });

  it('scoreBucket reports the decay factor it applied', () => {
    const bucket = scoreBucket(
      { resolvedCalls: 10, wins: 10, volume: '1', lastActiveAt: daysAgo(90) },
      1,
      AS_OF,
    );
    expect(bucket.decayFactor).toBeCloseTo(0.5, 12);
    expect(bucket.score).toBe(50);
  });
});
