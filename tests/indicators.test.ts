import { describe, expect, it } from 'vitest';
import { ema, macd, rsi, sma, valueAt } from '../src/indicators.js';

describe('sma', () => {
  it('computes SMA with a null warm-up window', () => {
    expect(sma([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('returns all nulls when the series is shorter than the period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });

  it('handles an empty series', () => {
    expect(sma([], 3)).toEqual([]);
  });

  it('handles a period of 1 (identity-ish)', () => {
    expect(sma([10, 20, 30], 1)).toEqual([10, 20, 30]);
  });
});

describe('ema', () => {
  it('seeds with the SMA and smooths (golden values)', () => {
    // period 3 -> k = 2/4 = 0.5; seed = SMA(1,2,3) = 2
    // ema[3] = 4*0.5 + 2*0.5 = 3 ; ema[4] = 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('returns all nulls when the series is shorter than the period', () => {
    expect(ema([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it('never produces NaN for a flat series', () => {
    const out = ema(new Array(50).fill(7), 10);
    expect(out[out.length - 1] as number).toBeCloseTo(7, 9);
  });
});

describe('rsi', () => {
  it('returns 100 for a strictly rising series', () => {
    const out = rsi(Array.from({ length: 30 }, (_, i) => i + 1), 14);
    expect(out[out.length - 1]).toBe(100);
  });

  it('returns 0 for a strictly falling series', () => {
    const out = rsi(Array.from({ length: 30 }, (_, i) => 30 - i), 14);
    expect(out[out.length - 1]).toBe(0);
  });

  it('returns 50 for a flat series (no gains, no losses)', () => {
    const out = rsi(new Array(30).fill(42), 14);
    expect(out[out.length - 1]).toBe(50);
  });

  it('matches the canonical Wilder example (~70.5)', () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28,
    ];
    const out = rsi(closes, 14);
    const v = out[out.length - 1];
    expect(v).not.toBeNull();
    expect(v as number).toBeCloseTo(70.5, 0);
  });

  it('keeps leading values null while warming up', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
});

describe('macd', () => {
  const prices = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.1);

  it('returns aligned arrays of the same length', () => {
    const { macd: m, signal, histogram } = macd(prices);
    expect(m).toHaveLength(80);
    expect(signal).toHaveLength(80);
    expect(histogram).toHaveLength(80);
  });

  it('waits for the slow EMA before producing values', () => {
    const { macd: m, signal } = macd(prices);
    expect(m[24]).toBeNull();
    expect(m[25]).not.toBeNull();
    // signal = EMA(9) of the MACD line starting at index 25 -> first at 33
    expect(signal[32]).toBeNull();
    expect(signal[33]).not.toBeNull();
  });

  it('histogram equals macd minus signal everywhere', () => {
    const { macd: m, signal, histogram } = macd(prices);
    for (let i = 33; i < prices.length; i++) {
      expect(histogram[i]).toBeCloseTo((m[i] as number) - (signal[i] as number), 9);
    }
  });

  it('contains no NaN anywhere', () => {
    const { macd: m, signal, histogram } = macd(prices);
    for (const arr of [m, signal, histogram]) {
      for (const v of arr) expect(Number.isNaN(v as number)).toBe(false);
    }
  });

  it('handles short series gracefully', () => {
    const { macd: m, signal, histogram } = macd([1, 2, 3], 12, 26, 9);
    expect(m).toEqual([null, null, null]);
    expect(signal).toEqual([null, null, null]);
    expect(histogram).toEqual([null, null, null]);
  });
});

describe('valueAt', () => {
  it('reads from the end of the series', () => {
    expect(valueAt([null, null, 1, 2, 3], 0)).toBe(3);
    expect(valueAt([null, null, 1, 2, 3], 2)).toBe(1);
    expect(valueAt([null, null, 1, 2, 3], 5)).toBeNull();
  });
});
