/**
 * The "AI" signal engine.
 *
 * Indicator outputs are combined into a weighted score in [-1, 1]. Every
 * component is a small, documented, deterministic mapping — no black box.
 * The engine classifies BUY / SELL / HOLD, derives a confidence percentage,
 * and emits human-readable reasoning that explains which indicator moved the
 * score and by how much.
 */

import { ema, macd, rsi, sma, valueAt } from './indicators.js';
import type { PriceSample } from './history.js';

// ---------------------------------------------------------------------------
// Documented constants
// ---------------------------------------------------------------------------

export const BUY_THRESHOLD = 0.3;
export const SELL_THRESHOLD = -0.3;

/**
 * Component weights (must sum to 1). Momentum/trend get the most weight;
 * RSI acts as a mean-reversion overlay.
 */
export const SIGNAL_WEIGHTS = {
  rsi: 0.15, // mean-reversion: oversold -> bullish, overbought -> bearish
  macd: 0.25, // momentum: histogram above/below zero
  sma: 0.15, // position vs. 20-bar average
  ema: 0.15, // position vs. 20-bar exponential average
  trend: 0.3, // slope of the 20-bar SMA over the last 5 bars
} as const;

export const RSI_PERIOD = 14;
export const SMA_PERIOD = 20;
export const EMA_PERIOD = 20;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const TREND_LOOKBACK = 5;

/** MACD line as % of price that maps to a full ±1 component. */
export const MOMENTUM_SCALE = 100;
/** % deviation from an average that maps to a full ±1 component. */
export const DEVIATION_SCALE = 10;
/** % move of SMA(20) over TREND_LOOKBACK bars that maps to a full ±1 component. */
export const TREND_SCALE = 100;
/** RSI contributes at most ±0.5 (softened around the neutral 50). */
export const RSI_MAX_CONTRIBUTION = 0.5;

/** Sample count at which history is considered "sufficient" (full confidence). */
export const REQUIRED_SAMPLES = 120;
/** Fewer available components than this makes the signal provisional. */
export const MIN_COMPONENTS = 3;

export type Signal = 'BUY' | 'SELL' | 'HOLD';
export type ComponentName = keyof typeof SIGNAL_WEIGHTS;

export interface IndicatorSnapshot {
  sma20: number | null;
  ema20: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
}

export interface SignalResult {
  symbol: string;
  price: number;
  timestamp: number;
  samples: number;
  dataSufficient: boolean;
  indicators: IndicatorSnapshot;
  components: Record<ComponentName, number | null>;
  /** Weighted score in [-1, 1]. Positive = bullish, negative = bearish. */
  score: number;
  signal: Signal;
  /** 0-100. Reflects conviction (|score|) and history sufficiency. */
  confidence: number;
  reasoning: string[];
}

// ---------------------------------------------------------------------------
// Component mappings
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** RSI: below 50 -> bullish (oversold), above 50 -> bearish. Maps [0, 100] to ±RSI_MAX_CONTRIBUTION. */
function rsiComponent(rsiValue: number | null): number | null {
  if (rsiValue === null) return null;
  return clamp((50 - rsiValue) / 100, -RSI_MAX_CONTRIBUTION, RSI_MAX_CONTRIBUTION);
}

/**
 * MACD momentum: the MACD line (EMA12 − EMA26) normalized by price. In a
 * steady trend the line carries the signal; the histogram (line vs. its own
 * EMA) is only a confirmation of direction.
 */
function momentumComponent(
  macdLine: number | null,
  price: number,
): number | null {
  if (macdLine === null || price <= 0) return null;
  return clamp((macdLine / price) * MOMENTUM_SCALE, -1, 1);
}

/** (price − average) / average, scaled. */
function deviationComponent(price: number, average: number | null): number | null {
  if (average === null || average <= 0) return null;
  return clamp(((price - average) / average) * DEVIATION_SCALE, -1, 1);
}

/** Slope of the SMA line over the last TREND_LOOKBACK bars. */
function trendComponent(smaSeries: (number | null)[]): number | null {
  const now = valueAt(smaSeries, 0);
  const before = valueAt(smaSeries, TREND_LOOKBACK);
  if (now === null || before === null || before <= 0) return null;
  return clamp(((now - before) / before) * TREND_SCALE, -1, 1);
}

// ---------------------------------------------------------------------------
// Reasoning helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function fmtPrice(p: number): string {
  const a = Math.abs(p);
  if (a >= 1000) return p.toFixed(2);
  if (a >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

function componentLine(
  label: string,
  state: string,
  contribution: number,
): string {
  const sign = contribution >= 0 ? '+' : '';
  return state ? `${label} ${state} → ${sign}${contribution.toFixed(3)} pts` : `${label} → ${sign}${contribution.toFixed(3)} pts`;
}

function buildReasoning(
  components: Record<ComponentName, number | null>,
  indicators: IndicatorSnapshot,
  price: number,
  score: number,
  signal: Signal,
  confidence: number,
  samples: number,
  componentCount: number,
): string[] {
  const lines: string[] = [];

  const rsiC = components.rsi;
  if (rsiC !== null) {
    const v = indicators.rsi14 as number;
    const zone =
      v >= 70 ? 'overbought' : v <= 30 ? 'oversold' : v > 50 ? 'above mid' : v < 50 ? 'below mid' : 'at mid';
    lines.push(componentLine(`RSI(${RSI_PERIOD}) = ${v.toFixed(1)} (${zone})`, '', rsiC));
  }

  const macdC = components.macd;
  if (macdC !== null) {
    const line = indicators.macd as number;
    const hist = indicators.macdHistogram as number;
    const dir = line >= 0 ? 'positive' : 'negative';
    const histDir = hist >= 0 ? 'above' : 'below';
    lines.push(
      componentLine(
        `MACD(${MACD_FAST},${MACD_SLOW}) momentum ${dir} (${pct(line / price)} of price, histogram ${histDir} zero)`,
        '',
        macdC,
      ),
    );
  }

  const smaC = components.sma;
  if (smaC !== null) {
    const avg = indicators.sma20 as number;
    const dir = price >= avg ? 'above' : 'below';
    lines.push(componentLine(`Price ${fmtPrice(price)} ${dir} SMA(${SMA_PERIOD}) ${fmtPrice(avg)}`, `(${pct((price - avg) / avg)})`, smaC));
  }

  const emaC = components.ema;
  if (emaC !== null) {
    const avg = indicators.ema20 as number;
    const dir = price >= avg ? 'above' : 'below';
    lines.push(componentLine(`Price ${fmtPrice(price)} ${dir} EMA(${EMA_PERIOD}) ${fmtPrice(avg)}`, `(${pct((price - avg) / avg)})`, emaC));
  }

  const trendC = components.trend;
  if (trendC !== null) {
    const dir = trendC >= 0 ? 'rising' : 'falling';
    const move = (Math.abs(trendC) / TREND_SCALE) * 100;
    lines.push(
      componentLine(`SMA(${SMA_PERIOD}) ${dir} ${move.toFixed(2)}% over ${TREND_LOOKBACK} bars`, '', trendC),
    );
  }

  if (componentCount < MIN_COMPONENTS) {
    lines.push(
      `Only ${componentCount}/${Object.keys(SIGNAL_WEIGHTS).length} indicators available — signal is provisional.`,
    );
  }

  lines.push(
    `Weighted score ${score >= 0 ? '+' : ''}${score.toFixed(3)} → ${signal} ` +
      `(thresholds: BUY ≥ +${BUY_THRESHOLD}, SELL ≤ ${SELL_THRESHOLD})`,
  );
  lines.push(
    `Confidence ${confidence}% ` +
      (samples >= REQUIRED_SAMPLES
        ? `(${samples} samples, sufficient history)`
        : `(${samples} samples — short history, confidence reduced)`),
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function computeSignal(symbol: string, samples: PriceSample[]): SignalResult {
  if (samples.length === 0) {
    return {
      symbol,
      price: 0,
      timestamp: 0,
      samples: 0,
      dataSufficient: false,
      indicators: {
        sma20: null,
        ema20: null,
        rsi14: null,
        macd: null,
        macdSignal: null,
        macdHistogram: null,
      },
      components: { rsi: null, macd: null, sma: null, ema: null, trend: null },
      score: 0,
      signal: 'HOLD',
      confidence: 0,
      reasoning: [`No price samples available for ${symbol}.`],
    };
  }

  const prices = samples.map((s) => s.price);
  const last = samples[samples.length - 1];
  const price = last.price;
  const timestamp = last.ts;

  const sma20Series = sma(prices, SMA_PERIOD);
  const ema20Series = ema(prices, EMA_PERIOD);
  const rsi14Series = rsi(prices, RSI_PERIOD);
  const macdResult = macd(prices, MACD_FAST, MACD_SLOW, MACD_SIGNAL);

  const indicators: IndicatorSnapshot = {
    sma20: valueAt(sma20Series, 0),
    ema20: valueAt(ema20Series, 0),
    rsi14: valueAt(rsi14Series, 0),
    macd: valueAt(macdResult.macd, 0),
    macdSignal: valueAt(macdResult.signal, 0),
    macdHistogram: valueAt(macdResult.histogram, 0),
  };

  const components: Record<ComponentName, number | null> = {
    rsi: rsiComponent(indicators.rsi14),
    macd: momentumComponent(indicators.macd, price),
    sma: deviationComponent(price, indicators.sma20),
    ema: deviationComponent(price, indicators.ema20),
    trend: trendComponent(sma20Series),
  };

  let score = 0;
  let componentCount = 0;
  for (const name of Object.keys(SIGNAL_WEIGHTS) as ComponentName[]) {
    const c = components[name];
    if (c !== null) {
      score += SIGNAL_WEIGHTS[name] * c;
      componentCount++;
    }
  }

  const signal: Signal = score > BUY_THRESHOLD ? 'BUY' : score < SELL_THRESHOLD ? 'SELL' : 'HOLD';

  const dataSufficient = prices.length >= REQUIRED_SAMPLES;
  const sufficiency = Math.min(1, prices.length / REQUIRED_SAMPLES);
  let confidence = Math.min(0.95, 0.4 + Math.abs(score)) * sufficiency;
  if (componentCount < MIN_COMPONENTS) confidence *= 0.5;
  confidence = Math.round(confidence * 100);

  const reasoning = buildReasoning(
    components,
    indicators,
    price,
    score,
    signal,
    confidence,
    prices.length,
    componentCount,
  );

  return {
    symbol,
    price,
    timestamp,
    samples: prices.length,
    dataSufficient,
    indicators,
    components,
    score,
    signal,
    confidence,
    reasoning,
  };
}

/** Human-friendly price formatting shared by the CLI and the dashboard. */
export function formatPrice(p: number): string {
  return fmtPrice(p);
}
