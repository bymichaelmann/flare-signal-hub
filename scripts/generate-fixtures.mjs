/**
 * Regenerates the deterministic fixture price series committed in fixtures/.
 *
 * Fixtures let `--fixture` mode (the CLI default) run fully offline with a
 * stable, reproducible series. Data is a seeded geometric random walk shaped
 * per symbol; timestamps end at a fixed point so the output is byte-identical
 * across runs.
 *
 *   node scripts/generate-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const N_SAMPLES = 240;
const STEP_SECONDS = 60;
// Fixed "now" so regeneration is deterministic.
const END_TS = 1785939145;

// seed, base price, per-step drift, per-step volatility, display precision
const SYMBOLS = {
  'FLR/USD': { seed: 1011, base: 0.005997, drift: 0.00008, vol: 0.0042, decimals: 6 },
  'BTC/USD': { seed: 2011, base: 64439.49, drift: -0.00012, vol: 0.0078, decimals: 2 },
  'ETH/USD': { seed: 3011, base: 3512.4, drift: 0.0002, vol: 0.0092, decimals: 2 },
  'XRP/USD': { seed: 4011, base: 0.5241, drift: 0.0003, vol: 0.0068, decimals: 4 },
  'DOGE/USD': { seed: 5011, base: 0.1598, drift: -0.0002, vol: 0.0108, decimals: 5 },
  'SOL/USD': { seed: 6011, base: 148.7, drift: 0.0004, vol: 0.0116, decimals: 2 },
};

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

mkdirSync(FIXTURES_DIR, { recursive: true });

for (const [symbol, cfg] of Object.entries(SYMBOLS)) {
  const rng = mulberry32(cfg.seed);
  const samples = [];
  let price = cfg.base;
  for (let i = 0; i < N_SAMPLES; i++) {
    price = price * (1 + cfg.drift + cfg.vol * gaussian(rng));
    samples.push({
      ts: END_TS - (N_SAMPLES - 1 - i) * STEP_SECONDS,
      price: round(price, cfg.decimals),
    });
  }
  const file = join(FIXTURES_DIR, `${symbol.replaceAll('/', '_')}.json`);
  const payload = {
    symbol,
    description: 'Deterministic fixture series (seeded random walk) for offline --fixture mode.',
    intervalSeconds: STEP_SECONDS,
    samples,
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${file} (${samples.length} samples)`);
}
