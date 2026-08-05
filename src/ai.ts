/**
 * Optional LLM narrative layer.
 *
 * Turns a computed signal + recent prices into a short plain-language market
 * summary via any OpenAI-compatible chat-completions endpoint. Strictly
 * optional: if `OPENAI_API_KEY` is not configured the module reports
 * `skipped` and the CLI continues — it never fails, never blocks, and is
 * never required for core functionality.
 */

import type { SignalResult } from './signals.js';

export type NarrativeStatus = 'configured' | 'skipped' | 'failed';

export interface NarrativeOutcome {
  narrative: string | null;
  status: NarrativeStatus;
}

export function isAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = env.OPENAI_API_KEY;
  return typeof key === 'string' && key.trim() !== '';
}

export interface GenerateNarrativeOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 20_000;

export async function generateNarrative(
  signal: SignalResult,
  prices: number[],
  options: GenerateNarrativeOptions = {},
): Promise<string | null> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  const recent = prices.slice(-30).map((p) => p.toPrecision(5)).join(', ');
  const userMessage =
    `Latest signal for ${signal.symbol}:\n` +
    `- price: ${signal.price}\n` +
    `- signal: ${signal.signal} (confidence ${signal.confidence}%, score ${signal.score.toFixed(3)})` +
    `\n- indicators: SMA20=${fmt(signal.indicators.sma20)} EMA20=${fmt(signal.indicators.ema20)} ` +
    `RSI14=${fmt(signal.indicators.rsi14)} MACD-hist=${fmt(signal.indicators.macdHistogram)}\n` +
    `- engine reasoning: ${signal.reasoning.join('; ')}\n` +
    `Recent prices (oldest to newest): ${recent}\n\n` +
    `Write 3-4 sentences summarizing the market stance in plain language. ` +
    `No markdown, no boilerplate, no disclaimer.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content:
              'You are a concise, jargon-free market analyst for Flare ecosystem assets.',
          },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience wrapper that reports why no narrative is available. */
export async function narrativeForSignal(
  signal: SignalResult,
  prices: number[],
  options: GenerateNarrativeOptions = {},
): Promise<NarrativeOutcome> {
  if (!isAiConfigured()) return { narrative: null, status: 'skipped' };
  const narrative = await generateNarrative(signal, prices, options);
  return { narrative, status: narrative ? 'configured' : 'failed' };
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(4);
}
