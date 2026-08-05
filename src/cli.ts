#!/usr/bin/env node
/**
 * flare-signal-hub CLI.
 *
 * Commands:
 *   signal    — compute explainable BUY/HOLD/SELL signals for a set of feeds
 *   sample    — poll live FTSOv2 feeds and accumulate a local price history
 *   dashboard — render a self-contained HTML dashboard
 *
 * `--fixture` mode (the default) is fully deterministic and needs no network;
 * `--live` reads real feeds from Flare mainnet via FLARE_RPC_URL.
 */

import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KNOWN_SYMBOLS, createFeedReader } from './feeds.js';
import type { FeedReader } from './feeds.js';
import {
  appendSample,
  loadFixtureSeries,
  loadHistory,
  saveHistory,
} from './history.js';
import type { PriceSample } from './history.js';
import { computeSignal, formatPrice } from './signals.js';
import type { SignalResult } from './signals.js';
import { narrativeForSignal } from './ai.js';
import { buildDashboardData, renderDashboard } from './dashboard.js';

const DEFAULT_SYMBOLS = KNOWN_SYMBOLS.join(',');
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseSymbols(list: string): string[] {
  const seen = new Set<string>();
  for (const raw of list.split(',')) {
    const s = raw.trim();
    if (s) seen.add(s);
  }
  if (seen.size === 0) throw new Error('no symbols given (use --symbols FLR/USD,BTC/USD)');
  return [...seen];
}

/** parseInt with an explicit radix — safe as a commander parse fn (commander passes (value, previous)). */
function asInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** parseInt with an explicit radix — safe as a commander parse fn (commander passes (value, previous)). */
const parseInt10 = (value: string): number => parseInt(value, 10);

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [
    line(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Shared sampling / series logic
// ---------------------------------------------------------------------------

export interface SampleProgress {
  (message: string): void;
}

/** Poll a feed `count` times, sleeping `intervalSeconds` between reads. */
export async function sampleSeries(
  reader: FeedReader,
  symbol: string,
  count: number,
  intervalSeconds: number,
  progress?: SampleProgress,
): Promise<PriceSample[]> {
  const samples: PriceSample[] = [];
  for (let i = 0; i < count; i++) {
    const sample = await reader.read(symbol);
    samples.push({ ts: sample.timestamp, price: sample.price });
    progress?.(
      `[${i + 1}/${count}] ${symbol} = ${formatPrice(sample.price)} @ ` +
        `${new Date(sample.timestamp * 1000).toISOString()}`,
    );
    if (i < count - 1 && intervalSeconds > 0) await sleep(intervalSeconds * 1000);
  }
  return samples;
}

export interface SignalOptions {
  symbols: string[];
  mode: 'fixture' | 'live';
  historySize: number;
  intervalSeconds: number;
  minLiveSamples: number;
  llm: boolean;
  json: boolean;
  out?: string;
  progress?: SampleProgress;
}

export interface SignalRunResult {
  reports: SignalResult[];
  narratives: (string | null)[];
}

/**
 * Compute signals for the requested symbols.
 * - fixture mode: deterministic bundled series, no network, no disk writes.
 * - live mode: stored local history is reused when long enough, otherwise a
 *   warm-up sample run builds one; a fresh sample is always appended first.
 */
export async function runSignal(opts: SignalOptions, reader?: FeedReader): Promise<SignalRunResult> {
  const progress = opts.progress ?? (() => {});
  const feedReader = reader ?? (opts.mode === 'live' ? createFeedReader() : null);

  const reports: SignalResult[] = [];
  const narratives: (string | null)[] = [];
  const notices = new Set<string>();

  for (const symbol of opts.symbols) {
    const samples = await seriesForSignal(symbol, opts, feedReader, progress);
    const report = computeSignal(symbol, samples);
    reports.push(report);

    if (opts.llm) {
      const outcome = await narrativeForSignal(report, samples.map((s) => s.price));
      narratives.push(outcome.narrative);
      if (outcome.status === 'skipped') {
        notices.add(
          'OPENAI_API_KEY not set — LLM narrative skipped (the signal engine still works without it).',
        );
      } else if (outcome.status === 'failed') {
        notices.add('LLM narrative unavailable (API error) — continuing without it.');
      }
    } else {
      narratives.push(null);
    }
  }

  for (const notice of notices) progress(`note: ${notice}`);
  return { reports, narratives };
}

async function seriesForSignal(
  symbol: string,
  opts: SignalOptions,
  reader: FeedReader | null,
  progress: SampleProgress,
): Promise<PriceSample[]> {
  if (opts.mode === 'fixture') {
    return loadFixtureSeries(symbol);
  }

  if (!reader) {
    throw new Error('internal error: live mode requires a feed reader');
  }

  const stored = loadHistory(symbol);
  if (stored.length < opts.minLiveSamples) {
    progress(
      `warming up ${symbol}: sampling ${opts.historySize} prices every ${opts.intervalSeconds}s ` +
        '(FTSOv2 has no cheap on-chain history — the tool builds its own)',
    );
    const warmed = await sampleSeries(reader, symbol, opts.historySize, opts.intervalSeconds, progress);
    saveHistory(symbol, warmed);
    return warmed;
  }

  const fresh = await reader.read(symbol);
  const merged = [...stored, { ts: fresh.timestamp, price: fresh.price }];
  saveHistory(symbol, merged);
  progress(`${symbol}: appended fresh sample ${formatPrice(fresh.price)} @ ${fresh.timestamp}`);
  return merged;
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('flare-signal-hub')
  .description('Explainable AI trading signals from FTSOv2 price feeds on Flare')
  .version(pkg.version);

program
  .command('signal')
  .description('Compute explainable BUY/HOLD/SELL signals for FTSOv2 feeds')
  .option('--symbols <list>', `comma-separated feed symbols (default: ${DEFAULT_SYMBOLS})`, DEFAULT_SYMBOLS)
  .option('--live', 'read live feeds over RPC (default mode is deterministic --fixture data)')
  .option('--fixture', 'use bundled deterministic fixture data (default)')
  .option('--history-size <n>', 'live warm-up sample count when no stored history (default 60)', parseInt10, 60)
  .option('--interval <seconds>', 'seconds between live samples (default 5)', parseInt10, 5)
  .option('--min-live-samples <n>', 'min stored samples before live mode reuses history (default 30)', parseInt10, 30)
  .option('--llm', 'append an LLM market narrative (requires OPENAI_API_KEY)')
  .option('--json', 'emit machine-readable JSON')
  .option('--out <file>', 'write output to a file instead of stdout')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const mode = opts.live && !opts.fixture ? 'live' : 'fixture';
      const symbols = parseSymbols(String(opts.symbols));
      const { reports, narratives } = await runSignal({
        symbols,
        mode,
        historySize: asInt(opts.historySize, 60),
        intervalSeconds: asInt(opts.interval, 5),
        minLiveSamples: asInt(opts.minLiveSamples, 30),
        llm: Boolean(opts.llm),
        json: Boolean(opts.json),
        out: opts.out === undefined ? undefined : String(opts.out),
        progress: (msg) => console.error(`  ${msg}`),
      });

      const payload = {
        generatedAt: new Date().toISOString(),
        mode,
        reports,
        narratives: narratives.filter((n): n is string => n !== null),
      };

      if (opts.json) {
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        if (opts.out) writeFileSync(String(opts.out), text);
        else process.stdout.write(text);
        return;
      }

      const rows = reports.map((r) => [
        r.symbol,
        formatPrice(r.price),
        r.signal,
        `${r.confidence}%`,
        r.score.toFixed(3),
        String(r.samples),
      ]);
      console.log(renderTable(['Symbol', 'Price', 'Signal', 'Conf', 'Score', 'Samples'], rows));
      reports.forEach((r, i) => {
        console.log(`\n${r.symbol} — reasoning`);
        for (const line of r.reasoning) console.log(`  ${line}`);
        if (narratives[i]) console.log(`\n  narrative: ${narratives[i]}`);
      });
      if (opts.out) {
        writeFileSync(String(opts.out), `${renderTable(['Symbol', 'Price', 'Signal', 'Conf', 'Score', 'Samples'], rows)}\n`);
      }
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('sample')
  .description('Poll live FTSOv2 feeds and accumulate a local price history')
  .option('--symbols <list>', `comma-separated feed symbols (default: ${DEFAULT_SYMBOLS})`, DEFAULT_SYMBOLS)
  .option('--interval <seconds>', 'seconds between samples (default 60)', parseInt10, 60)
  .option('--count <n>', 'samples per symbol (default 10)', parseInt10, 10)
  .option('--live', 'accepted for symmetry — sampling always reads live feeds')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const reader = createFeedReader();
      const symbols = parseSymbols(String(opts.symbols));
      const interval = asInt(opts.interval, 60);
      const count = asInt(opts.count, 10);
      for (const symbol of symbols) {
        const samples = await sampleSeries(reader, symbol, count, interval, (msg) => console.error(`  ${msg}`));
        for (const s of samples) appendSample(symbol, s);
        console.error(`  ${symbol}: stored ${samples.length} samples`);
      }
      console.error('history written to the data directory (FLARE_SIGNAL_DATA_DIR, default ./data)');
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('dashboard')
  .description('Generate a self-contained HTML dashboard with signals and sparklines')
  .option('--symbols <list>', `comma-separated feed symbols (default: ${DEFAULT_SYMBOLS})`, DEFAULT_SYMBOLS)
  .option('--live', 'use live feeds (default mode is deterministic --fixture data)')
  .option('--fixture', 'use bundled deterministic fixture data (default)')
  .option('--history-size <n>', 'live warm-up sample count when no stored history (default 60)', parseInt10, 60)
  .option('--interval <seconds>', 'seconds between live samples (default 5)', parseInt10, 5)
  .option('--min-live-samples <n>', 'min stored samples before live mode reuses history (default 30)', parseInt10, 30)
  .option('--out <file>', 'output HTML file (default dashboard.html)', 'dashboard.html')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const mode = opts.live && !opts.fixture ? 'live' : 'fixture';
      const symbols = parseSymbols(String(opts.symbols));
      const out = String(opts.out);
      const { reports } = await runSignal({
        symbols,
        mode,
        historySize: asInt(opts.historySize, 60),
        intervalSeconds: asInt(opts.interval, 5),
        minLiveSamples: asInt(opts.minLiveSamples, 30),
        llm: false,
        json: false,
        progress: (msg) => console.error(`  ${msg}`),
      });

      const seriesBySymbol: Record<string, number[]> = {};
      for (const symbol of symbols) {
        const samples = mode === 'fixture' ? loadFixtureSeries(symbol) : loadHistory(symbol);
        seriesBySymbol[symbol] = samples.map((s) => s.price);
      }

      const html = renderDashboard(buildDashboardData(reports, seriesBySymbol, mode));
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, html);
      console.error(`dashboard written to ${resolve(out)}`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
