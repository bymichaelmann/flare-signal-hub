/**
 * Local price-history store.
 *
 * FTSOv2 exposes only the *current* feed value on chain — there is no cheap
 * historical endpoint. So the tool accumulates its own series: a sampler polls
 * the feed and appends samples to `data/<SYMBOL>.json`. Bundled deterministic
 * fixture series (used by `--fixture` mode) live in `fixtures/` and are
 * committed to the repo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PriceSample {
  /** Unix timestamp in seconds. */
  ts: number;
  price: number;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = join(moduleDir, '..', 'data');
let dataDir = process.env.FLARE_SIGNAL_DATA_DIR ?? defaultDataDir;

/** Point the sample store at a different directory (used by tests). */
export function setDataDir(dir: string): void {
  dataDir = dir;
}

export function getDataDir(): string {
  return dataDir;
}

export function symbolToFile(symbol: string): string {
  return `${symbol.replaceAll('/', '_')}.json`;
}

export function historyFilePath(symbol: string): string {
  return join(dataDir, symbolToFile(symbol));
}

function readSamples(file: string): PriceSample[] | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { samples?: PriceSample[] };
  return Array.isArray(raw.samples) ? raw.samples : null;
}

/** Samples accumulated locally for a symbol ([] when none exist yet). */
export function loadHistory(symbol: string): PriceSample[] {
  return readSamples(historyFilePath(symbol)) ?? [];
}

export function saveHistory(symbol: string, samples: PriceSample[]): void {
  mkdirSync(dataDir, { recursive: true });
  const payload = { symbol, samples, updatedAt: new Date().toISOString() };
  writeFileSync(historyFilePath(symbol), `${JSON.stringify(payload, null, 2)}\n`);
}

/** Append one sample, ignoring timestamps that are stale relative to the last stored one. */
export function appendSample(symbol: string, sample: PriceSample): PriceSample[] {
  const samples = loadHistory(symbol);
  if (samples.length > 0 && sample.ts <= samples[samples.length - 1].ts) {
    return samples;
  }
  samples.push(sample);
  saveHistory(symbol, samples);
  return samples;
}

/** Load the bundled deterministic fixture series for a symbol. */
export function loadFixtureSeries(symbol: string): PriceSample[] {
  const file = join(moduleDir, '..', 'fixtures', symbolToFile(symbol));
  const samples = readSamples(file);
  if (!samples || samples.length === 0) {
    const known = [
      'FLR/USD',
      'BTC/USD',
      'ETH/USD',
      'XRP/USD',
      'DOGE/USD',
      'SOL/USD',
    ].join(', ');
    throw new Error(
      `no fixture data for "${symbol}" (expected ${file}). ` +
        `Fixture mode supports: ${known}. Use --live to read real feeds, ` +
        `or regenerate fixtures with: node scripts/generate-fixtures.mjs`,
    );
  }
  return samples;
}

/** Series for a symbol from either the committed fixtures or the local sample store. */
export function getSeries(symbol: string, mode: 'fixture' | 'live'): PriceSample[] {
  return mode === 'fixture' ? loadFixtureSeries(symbol) : loadHistory(symbol);
}
