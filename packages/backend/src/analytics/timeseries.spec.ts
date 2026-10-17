import {
  bucketLabels,
  DEFAULT_FEE_SPLIT_BPS,
  fillSeries,
  fromUnits,
  growthPct,
  normalizeDecimal,
  parseFeeSplit,
  resolveWindow,
  sharePct,
  splitFee,
  toUnits,
  toUtcTimestampLiteral,
  truncateUtc,
} from './timeseries';

const NOW = new Date('2026-10-17T13:45:12.345Z');

describe('timeseries helpers (BE-033)', () => {
  describe('windows', () => {
    it('aligns hourly windows to bucket boundaries and includes the current bucket', () => {
      const w = resolveWindow('24h', 'hour', NOW);
      expect(w.to.toISOString()).toBe('2026-10-17T14:00:00.000Z');
      expect(w.from.toISOString()).toBe('2026-10-16T14:00:00.000Z');
      expect(w.previousFrom.toISOString()).toBe('2026-10-15T14:00:00.000Z');
      expect(w.bucketCount).toBe(24);
    });

    it('aligns daily windows to UTC midnight', () => {
      const w = resolveWindow('30d', 'day', NOW);
      expect(w.to.toISOString()).toBe('2026-10-18T00:00:00.000Z');
      expect(w.from.toISOString()).toBe('2026-09-18T00:00:00.000Z');
      expect(w.bucketCount).toBe(30);
    });

    it('defaults the interval per range and rejects oversized series', () => {
      expect(resolveWindow('7d', undefined, NOW).interval).toBe('hour');
      expect(resolveWindow('1y', undefined, NOW).bucketCount).toBe(365);
      expect(() => resolveWindow('90d', 'hour', NOW)).toThrow(RangeError);
    });

    it('labels every bucket in order as UTC ISO strings', () => {
      const labels = bucketLabels(resolveWindow('24h', 'hour', NOW));
      expect(labels).toHaveLength(24);
      expect(labels[0]).toBe('2026-10-16T14:00:00.000Z');
      expect(labels[23]).toBe('2026-10-17T13:00:00.000Z');
      expect([...labels].sort()).toEqual(labels);
    });

    it('truncates like date_trunc and emits zone-less literals', () => {
      expect(truncateUtc(NOW, 'hour').toISOString()).toBe(
        '2026-10-17T13:00:00.000Z',
      );
      expect(truncateUtc(NOW, 'day').toISOString()).toBe(
        '2026-10-17T00:00:00.000Z',
      );
      expect(toUtcTimestampLiteral(NOW)).toBe('2026-10-17T13:45:12.345');
    });

    it('fills gaps with the empty value', () => {
      const out = fillSeries(['a', 'b', 'c'], new Map([['b', 5]]), 0);
      expect(out).toEqual([0, 5, 0]);
    });
  });

  describe('exact decimals', () => {
    it('round-trips Postgres numeric strings at 7dp', () => {
      expect(fromUnits(toUnits('123.4567891'))).toBe('123.4567891');
      expect(fromUnits(toUnits('-0.5'))).toBe('-0.5000000');
      expect(normalizeDecimal('42')).toBe('42.0000000');
      expect(normalizeDecimal(null)).toBe('0.0000000');
      expect(fromUnits(toUnits('0.1') + toUnits('0.2'))).toBe('0.3000000');
      expect(fromUnits(toUnits('99999999999999.9999999') + 1n)).toBe(
        '100000000000000.0000000',
      );
    });

    it('computes growth with a null when there is no baseline', () => {
      expect(growthPct('150', '100')).toBe(50);
      expect(growthPct('77', '101')).toBe(-23.76);
      expect(growthPct('5', '0')).toBeNull();
      expect(growthPct('0', '0')).toBeNull();
      expect(growthPct('-50', '-100')).toBe(50);
    });

    it('computes shares', () => {
      expect(sharePct('76', '86')).toBe(88.37);
      expect(sharePct('1', '0')).toBe(0);
    });
  });

  describe('fee split', () => {
    it('mirrors the governance contract default of 50/25/15/10', () => {
      expect(DEFAULT_FEE_SPLIT_BPS).toEqual({
        treasury: 5000,
        creator: 2500,
        buyback: 1500,
        burn: 1000,
      });
    });

    it('never loses dust: parts always sum to the total', () => {
      for (const total of ['10.0000001', '0.0000003', '1234567.8912345', '0']) {
        const s = splitFee(total);
        const sum =
          toUnits(s.treasury) +
          toUnits(s.creator) +
          toUnits(s.buyback) +
          toUnits(s.burn);
        expect(sum).toBe(toUnits(total));
      }
      expect(splitFee('10.0000001')).toEqual({
        total: '10.0000001',
        treasury: '5.0000000',
        creator: '2.5000000',
        buyback: '1.5000000',
        burn: '1.0000001',
      });
    });

    it('parses a configured split and rejects invalid ones', () => {
      expect(parseFeeSplit('7000,2000,1000,0')).toEqual({
        treasury: 7000,
        creator: 2000,
        buyback: 1000,
        burn: 0,
      });
      expect(parseFeeSplit('5000,5000')).toBe(DEFAULT_FEE_SPLIT_BPS);
      expect(parseFeeSplit('6000,2500,1500,1000')).toBe(DEFAULT_FEE_SPLIT_BPS);
      expect(parseFeeSplit('a,b,c,d')).toBe(DEFAULT_FEE_SPLIT_BPS);
      expect(parseFeeSplit(undefined)).toBe(DEFAULT_FEE_SPLIT_BPS);
    });
  });
});
