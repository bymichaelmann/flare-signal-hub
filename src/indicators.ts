/**
 * Pure technical-indicator math. No dependencies, no state, no I/O.
 *
 * Every function returns an array aligned with the input series. Positions
 * before enough data exists are `null` — callers must treat `null` as
 * "insufficient data" and never crash or emit NaN.
 */

export type Series = readonly number[];
export type IndicatorSeries = (number | null)[];

/** Simple moving average. Leading `period - 1` positions are null. */
export function sma(values: Series, period: number): IndicatorSeries {
  const out: IndicatorSeries = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * observations (the common convention), then smoothed with
 * `k = 2 / (period + 1)`.
 */
export function ema(values: Series, period: number): IndicatorSeries {
  const out: IndicatorSeries = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index (Wilder's smoothing).
 * - strictly rising series -> 100
 * - strictly falling series -> 0
 * - flat series -> 50 (degenerate case where gains and losses are both zero)
 */
export function rsi(values: Series, period = 14): IndicatorSeries {
  const out: IndicatorSeries = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100; // flat -> neutral; gains only -> 100
  }
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface MacdResult {
  macd: IndicatorSeries;
  signal: IndicatorSeries;
  histogram: IndicatorSeries;
}

/**
 * MACD: EMA(fast) − EMA(slow), its signal line (EMA of the MACD line), and
 * the histogram (MACD − signal). Aligned with the input series; all values
 * before the slow EMA is available are null.
 */
export function macd(
  values: Series,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);

  const macdLine: IndicatorSeries = new Array(values.length).fill(null);
  let firstIdx = -1;
  for (let i = 0; i < values.length; i++) {
    const f = fastEma[i];
    const s = slowEma[i];
    if (f !== null && s !== null) {
      macdLine[i] = f - s;
      if (firstIdx < 0) firstIdx = i;
    }
  }

  const empty: IndicatorSeries = new Array(values.length).fill(null);
  if (firstIdx < 0) return { macd: macdLine, signal: empty, histogram: empty };

  // EMA over the contiguous MACD segment starting at firstIdx.
  const segment: number[] = [];
  for (let i = firstIdx; i < values.length; i++) segment.push(macdLine[i] as number);
  const segmentEma = ema(segment, signalPeriod);

  const signalLine: IndicatorSeries = new Array(values.length).fill(null);
  const histogram: IndicatorSeries = new Array(values.length).fill(null);
  for (let i = 0; i < segmentEma.length; i++) {
    const v = segmentEma[i];
    if (v !== null) {
      signalLine[firstIdx + i] = v;
      histogram[firstIdx + i] = (macdLine[firstIdx + i] as number) - v;
    }
  }
  return { macd: macdLine, signal: signalLine, histogram };
}

/** Value at `fromEnd` positions from the end of an indicator series (0 = latest). */
export function valueAt(values: IndicatorSeries, fromEnd: number): number | null {
  const i = values.length - 1 - fromEnd;
  if (i < 0) return null;
  const v = values[i];
  return v === undefined ? null : v;
}
