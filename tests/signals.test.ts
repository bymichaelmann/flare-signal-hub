import { describe, expect, it } from 'vitest';
import {
  BUY_THRESHOLD,
  SELL_THRESHOLD,
  SIGNAL_WEIGHTS,
  computeSignal,
} from '../src/signals.js';
import type { PriceSample } from '../src/history.js';

const toSamples = (prices: number[], startTs = 1_700_000_000): PriceSample[] =>
  prices.map((price, i) => ({ ts: startTs + i * 60, price }));

const geometric = (steps: number, growth: number): number[] =>
  Array.from({ length: steps }, (_, i) => 100 * Math.pow(1 + growth, i));

describe('signal engine — weights and constants', () => {
  it('component weights sum to 1', () => {
    const total = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  it('thresholds are ordered correctly', () => {
    expect(SELL_THRESHOLD).toBeLessThan(BUY_THRESHOLD);
  });
});

describe('signal engine — classification', () => {
  it('classifies a strong uptrend as BUY', () => {
    const r = computeSignal('TEST/USD', toSamples(geometric(200, 0.002)));
    expect(r.score).toBeGreaterThan(BUY_THRESHOLD);
    expect(r.signal).toBe('BUY');
  });

  it('classifies a strong downtrend as SELL', () => {
    const r = computeSignal('TEST/USD', toSamples(geometric(200, -0.002)));
    expect(r.score).toBeLessThan(SELL_THRESHOLD);
    expect(r.signal).toBe('SELL');
  });

  it('classifies a flat series as HOLD with near-zero score', () => {
    const r = computeSignal('TEST/USD', toSamples(new Array(200).fill(50)));
    expect(r.signal).toBe('HOLD');
    expect(Math.abs(r.score)).toBeLessThan(0.05);
  });

  it('keeps the score inside [-1, 1]', () => {
    for (const growth of [0.004, 0.001, 0, -0.001, -0.004]) {
      const r = computeSignal('TEST/USD', toSamples(geometric(200, growth)));
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('handles an empty series gracefully', () => {
    const r = computeSignal('TEST/USD', []);
    expect(r.signal).toBe('HOLD');
    expect(r.confidence).toBe(0);
    expect(r.reasoning.length).toBeGreaterThan(0);
  });

  it('returns HOLD with a provisional note on very short history', () => {
    const r = computeSignal('TEST/USD', toSamples(geometric(10, 0.01)));
    expect(r.signal).toBe('HOLD');
    expect(r.confidence).toBeLessThanOrEqual(10);
    expect(r.reasoning.join('\n')).toMatch(/provisional/);
  });
});

describe('signal engine — confidence', () => {
  it('is bounded to [0, 100]', () => {
    for (const growth of [0.004, 0.001, 0, -0.001, -0.004]) {
      const r = computeSignal('TEST/USD', toSamples(geometric(200, growth)));
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('rises with conviction (stronger trend → higher confidence)', () => {
    const mild = computeSignal('TEST/USD', toSamples(geometric(200, 0.0004)));
    const strong = computeSignal('TEST/USD', toSamples(geometric(200, 0.004)));
    expect(strong.confidence).toBeGreaterThan(mild.confidence);
  });

  it('is reduced when history is short', () => {
    const full = computeSignal('TEST/USD', toSamples(geometric(200, 0.001)));
    const short = computeSignal('TEST/USD', toSamples(geometric(60, 0.001)));
    expect(short.confidence).toBeLessThan(full.confidence);
    expect(short.dataSufficient).toBe(false);
    expect(full.dataSufficient).toBe(true);
  });
});

describe('signal engine — reasoning', () => {
  it('lists every indicator contribution plus a score summary', () => {
    const r = computeSignal('TEST/USD', toSamples(geometric(200, 0.002)));
    const text = r.reasoning.join('\n');
    expect(text).toMatch(/RSI\(14\)/);
    expect(text).toMatch(/SMA\(20\)/);
    expect(text).toMatch(/EMA\(20\)/);
    expect(text).toMatch(/Weighted score/);
    expect(text).toMatch(/Confidence/);
    expect(r.reasoning.length).toBeGreaterThanOrEqual(5);
  });

  it('explains the confidence calculation', () => {
    const r = computeSignal('TEST/USD', toSamples(geometric(200, 0.001)));
    expect(r.reasoning.join('\n')).toMatch(/sufficient history|short history/);
  });
});

describe('signal engine — determinism', () => {
  it('produces byte-identical output for identical input', () => {
    const samples = toSamples(geometric(200, 0.001));
    const a = computeSignal('TEST/USD', samples);
    const b = computeSignal('TEST/USD', samples);
    expect(a).toEqual(b);
  });
});
