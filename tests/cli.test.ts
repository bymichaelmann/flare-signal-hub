import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSignal, sampleSeries } from '../src/cli.js';
import type { SignalOptions } from '../src/cli.js';
import { setDataDir } from '../src/history.js';
import type { FeedReader } from '../src/feeds.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fsh-cli-'));
  setDataDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base: Omit<SignalOptions, 'symbols' | 'mode'> = {
  historySize: 60,
  intervalSeconds: 0,
  minLiveSamples: 30,
  llm: false,
  json: false,
};

describe('runSignal — fixture mode', () => {
  it('produces a well-formed report per symbol without network', async () => {
    const { reports } = await runSignal({
      ...base,
      symbols: ['FLR/USD', 'BTC/USD', 'ETH/USD'],
      mode: 'fixture',
    });
    expect(reports).toHaveLength(3);
    for (const r of reports) {
      expect(r.symbol).toMatch(/\/USD$/);
      expect(r.price).toBeGreaterThan(0);
      expect(['BUY', 'HOLD', 'SELL']).toContain(r.signal);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
      expect(r.samples).toBeGreaterThanOrEqual(100);
      expect(r.reasoning.length).toBeGreaterThan(0);
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic across runs (same input → same output)', async () => {
    const a = await runSignal({ ...base, symbols: ['FLR/USD', 'SOL/USD'], mode: 'fixture' });
    const b = await runSignal({ ...base, symbols: ['FLR/USD', 'SOL/USD'], mode: 'fixture' });
    expect(a.reports).toEqual(b.reports);
    expect(a.narratives).toEqual(b.narratives);
  });

  it('does not touch the sample store in fixture mode', async () => {
    await runSignal({ ...base, symbols: ['FLR/USD'], mode: 'fixture' });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('runSignal — live mode with a stub feed reader', () => {
  it('warms up history when the store is empty, then computes a signal', async () => {
    const prices = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.001, i));
    let i = 0;
    const stub: FeedReader = {
      rpcUrl: 'stub://local',
      read: async (symbol) => ({
        symbol,
        price: prices[Math.min(i++, prices.length - 1)] ?? 100,
        timestamp: 1_700_000_000 + i * 60,
      }),
    };
    const progress: string[] = [];
    const { reports } = await runSignal(
      {
        ...base,
        symbols: ['TEST/USD'],
        mode: 'live',
        minLiveSamples: 200, // force the warm-up path
        progress: (msg) => progress.push(msg),
      },
      stub,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.symbol).toBe('TEST/USD');
    expect(reports[0]!.samples).toBe(60); // warm-up historySize
    expect(progress.some((m) => /warming up/.test(m))).toBe(true);
  });

  it('appends a fresh sample to existing history and computes', async () => {
    const { appendSample } = await import('../src/history.js');
    appendSample('TEST/USD', { ts: 1_700_000_000, price: 100 });
    appendSample('TEST/USD', { ts: 1_700_000_060, price: 101 });
    appendSample('TEST/USD', { ts: 1_700_000_120, price: 102 });

    const stub: FeedReader = {
      rpcUrl: 'stub://local',
      read: async (symbol) => ({ symbol, price: 103, timestamp: 1_700_000_180 }),
    };
    const { reports } = await runSignal(
      { ...base, symbols: ['TEST/USD'], mode: 'live', minLiveSamples: 3 },
      stub,
    );
    expect(reports[0]!.samples).toBe(4);
    expect(reports[0]!.price).toBe(103);
  });
});

describe('sampleSeries', () => {
  it('polls a reader count times with progress callbacks', async () => {
    let calls = 0;
    const stub: FeedReader = {
      rpcUrl: 'stub://local',
      read: async (symbol) => {
        calls++;
        return { symbol, price: 10 + calls, timestamp: 1_700_000_000 + calls };
      },
    };
    const progress: string[] = [];
    const samples = await sampleSeries(stub, 'TEST/USD', 4, 0, (m) => progress.push(m));
    expect(calls).toBe(4);
    expect(samples).toHaveLength(4);
    expect(progress).toHaveLength(4);
    expect(samples[3]!.price).toBe(14);
  });
});
