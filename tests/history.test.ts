import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSample,
  getDataDir,
  loadFixtureSeries,
  loadHistory,
  saveHistory,
  setDataDir,
  symbolToFile,
} from '../src/history.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fsh-history-'));
  setDataDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('history store', () => {
  it('round-trips samples through save/load', () => {
    const samples = [
      { ts: 1, price: 1.1 },
      { ts: 2, price: 1.2 },
    ];
    saveHistory('FLR/USD', samples);
    expect(loadHistory('FLR/USD')).toEqual(samples);
  });

  it('appends samples and ignores stale/duplicate timestamps', () => {
    appendSample('X/USD', { ts: 100, price: 1 });
    const dup = appendSample('X/USD', { ts: 100, price: 2 });
    expect(dup).toHaveLength(1);
    expect(dup[0]?.price).toBe(1);
    appendSample('X/USD', { ts: 101, price: 3 });
    expect(loadHistory('X/USD')).toHaveLength(2);
  });

  it('persists to the configured data directory with the expected filename', () => {
    appendSample('FLR/USD', { ts: 5, price: 0.006 });
    const file = join(dir, symbolToFile('FLR/USD'));
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { symbol: string; samples: unknown[] };
    expect(raw.symbol).toBe('FLR/USD');
    expect(raw.samples).toHaveLength(1);
  });

  it('returns [] when no history file exists', () => {
    expect(loadHistory('NOPE/USD')).toEqual([]);
  });

  it('getDataDir reflects setDataDir', () => {
    expect(getDataDir()).toBe(dir);
  });

  it('creates the data directory on first save', () => {
    const nested = join(dir, 'a', 'b');
    setDataDir(nested);
    saveHistory('X/USD', [{ ts: 1, price: 1 }]);
    expect(existsSync(join(nested, symbolToFile('X/USD')))).toBe(true);
  });
});

describe('fixture series', () => {
  it('loads a committed fixture with at least 100 samples in ascending time order', () => {
    const samples = loadFixtureSeries('FLR/USD');
    expect(samples.length).toBeGreaterThanOrEqual(100);
    expect(samples[0]!.ts).toBeLessThan(samples[samples.length - 1]!.ts);
  });

  it('fixture prices are strictly positive and finite', () => {
    for (const s of loadFixtureSeries('BTC/USD')) {
      expect(s.price).toBeGreaterThan(0);
      expect(Number.isFinite(s.price)).toBe(true);
    }
  });

  it('throws a helpful error for unknown symbols', () => {
    expect(() => loadFixtureSeries('NOPE/USD')).toThrow(/no fixture data/i);
  });

  it('fixture data is deterministic across loads', () => {
    expect(loadFixtureSeries('ETH/USD')).toEqual(loadFixtureSeries('ETH/USD'));
  });
});
