# Flare Signal Hub

Explainable BUY / HOLD / SELL trading signals for assets priced by the
FTSOv2 oracle on [Flare](https://flare.network) — delivered as a CLI and a
self-contained HTML dashboard.

The tool reads **real FTSOv2 price feeds directly on chain** (no third-party
price API), runs deterministic technical indicators (SMA, EMA, RSI, MACD),
blends them into a transparent weighted score, and explains every decision in
plain text: which indicator moved the score, by how much, and why.

```
$ flare-signal-hub signal --symbols FLR/USD,BTC/USD,ETH/USD

Symbol   Price     Signal  Conf  Score   Samples
-------  --------  ------  ----  ------  -------
FLR/USD  0.006295  HOLD    55%   -0.145  240
BTC/USD  58710.19  HOLD    42%   -0.024  240
ETH/USD  3703.86   BUY     95%   0.611   240

ETH/USD — reasoning
  RSI(14) = 65.8 (above mid) → -0.158 pts
  MACD(12,26) momentum positive (1.19% of price, histogram above zero) → +1.000 pts
  Price 3703.86 above SMA(20) 3593.95 (3.06%) → +0.306 pts
  Price 3703.86 above EMA(20) 3609.42 (2.62%) → +0.262 pts
  SMA(20) rising 1.00% over 5 bars → +1.000 pts
  Weighted score +0.611 → BUY (thresholds: BUY ≥ +0.3, SELL ≤ -0.3)
  Confidence 95% (240 samples, sufficient history)
```

## Features

- **On-chain FTSOv2 reads** — resolves the `FtsoV2` contract through Flare's
  `ContractRegistry` (with a stable mainnet fallback) and calls
  `getFeedByIdInWei` for any feed symbol (`FLR/USD`, `BTC/USD`, `ETH/USD`,
  `XRP/USD`, `DOGE/USD`, `SOL/USD`, …).
- **Explainable signals** — every signal comes with a weighted score, a
  confidence percentage, and a per-indicator reasoning trail. No black box.
- **Deterministic `--fixture` mode** (default) — bundles seeded, committed
  fixture series so the tool demos and tests fully offline.
- **Price sampler** — FTSOv2 has no cheap historical endpoint on chain, so
  the tool accumulates its own history by polling the live feed into a local
  JSON store (`data/<SYMBOL>.json`).
- **Self-contained dashboard** — a single HTML file with inline CSS/JS and SVG
  sparklines; no CDN, no external requests, works from `file://`.
- **Optional LLM narrative** — turns the signal + recent prices into a
  3–4 sentence market summary via any OpenAI-compatible endpoint. Gated on
  `OPENAI_API_KEY`; skipped gracefully when unset.

## How it works

### FTSO and FTSOv2

Flare's **FTSO** (Flare Time Series Oracle) is a decentralized price-feed
network: independent providers vote on asset prices every epoch, and the
protocol aggregates the results into on-chain feeds. **FTSOv2** is the second
generation — prices are published with 18 decimals and each feed is addressed
by a 21-byte id (`0x01` + ASCII symbol, zero-padded; e.g. `FLR/USD` →
`0x01464c522f55534400000000000000000000000000`).

Because every feed is a plain view call, no API key or HTTP price service is
needed:

```
FtsoV2.getFeedByIdInWei(0x01 464c522f555344 00000000000000000000)
  -> value 5997000000000000000 (wei, 18 decimals) = 5.997 USD
  -> timestamp 1785939145
```

FTSOv2 exposes only the **current** value on chain, so `flare-signal-hub`
samples the feed over time and stores the series locally — that stored series
is what the indicators run on.

### Signal engine

Pure, deterministic math. Each indicator contributes a component in [-1, 1];
the weighted sum is the score, classified as:

| Score | Signal |
| --- | --- |
| ≥ +0.30 | BUY |
| ≤ -0.30 | SELL |
| otherwise | HOLD |

| Component | Weight | What it measures | Full ±1 at |
| --- | --- | --- | --- |
| Trend (SMA slope) | 0.30 | 20-bar SMA move over the last 5 bars | ±1% move |
| MACD momentum | 0.25 | (EMA12 − EMA26) as % of price | ±1% of price |
| RSI(14) | 0.15 | mean-reversion around 50 (softened) | ±0.5 max contribution |
| Price vs SMA(20) | 0.15 | deviation from the simple average | ±10% deviation |
| Price vs EMA(20) | 0.15 | deviation from the exponential average | ±10% deviation |

Confidence (0–100%) combines conviction (`|score|`) with history sufficiency
(full at 120+ samples; short histories reduce it and mark the signal as
provisional). All constants live at the top of `src/signals.ts`.

## Install

Requires Node.js ≥ 22.

```sh
npm install
npm run build
npm link          # optional: exposes the `flare-signal-hub` command
```

## Usage

### Signals

```sh
# Deterministic demo using bundled fixture data (default, no network)
flare-signal-hub signal --symbols FLR/USD,BTC/USD

# Live feeds from Flare mainnet
flare-signal-hub signal --symbols FLR/USD,BTC/USD --live

# Machine-readable output
flare-signal-hub signal --symbols SOL/USD --json | jq '.reports[0].signal'

# Add an LLM narrative (requires OPENAI_API_KEY)
flare-signal-hub signal --symbols FLR/USD --live --llm

# Live mode with no stored history: warm up a series first
flare-signal-hub signal --symbols FLR/USD --live --history-size 60 --interval 5
```

In `--live` mode the tool reuses locally sampled history when it is long
enough (default ≥ 30 samples) and appends a fresh sample; otherwise it runs a
warm-up sampling pass first. `FLARE_RPC_URL` overrides the RPC endpoint.

### Sampling history

```sh
# Poll FLR/USD every 60s, 10 times, appending to data/FLR_USD.json
flare-signal-hub sample --symbols FLR/USD --interval 60 --count 10

# Multiple symbols at a faster cadence
flare-signal-hub sample --symbols FLR/USD,BTC/USD,ETH/USD --interval 30 --count 20
```

Run `sample` periodically (cron, systemd timer, …) to keep the local series
growing; then `signal --live` computes on real accumulated history.

### Dashboard

```sh
flare-signal-hub dashboard --out dashboard.html          # fixture data
flare-signal-hub dashboard --out dashboard.html --live   # live feeds
```

The output is a single self-contained HTML file: signal cards, confidence
bars, indicator snapshots, reasoning, and SVG sparklines.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `FLARE_RPC_URL` | `https://flare-api.flare.network/ext/C/rpc` | Flare JSON-RPC endpoint (chain 14) |
| `FLARE_SIGNAL_DATA_DIR` | `./data` | Directory for sampled price history |
| `OPENAI_API_KEY` | — | Enables the optional LLM narrative |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible chat-completions base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model used for the narrative |

## Development

```sh
npm test          # deterministic unit tests (no network)
npm run build     # tsc -> dist/
npm run gen:fixtures   # regenerate fixtures/ (seeded, deterministic)
```

Live smoke tests live in `tests/live.test.ts` and are **skipped unless
`LIVE_RPC` is set**:

```sh
LIVE_RPC=https://flare-api.flare.network/ext/C/rpc npx vitest run tests/live.test.ts
```

## Project layout

```
src/
  feeds.ts       FTSOv2 on-chain client (registry resolution, feed ids, wei→decimal)
  history.ts     local sample store + committed fixture loader
  indicators.ts  pure SMA / EMA / RSI / MACD math
  signals.ts     weighted signal engine (score, classification, reasoning)
  ai.ts          optional LLM narrative (OpenAI-compatible, gated)
  dashboard.ts   self-contained HTML dashboard renderer
  cli.ts         CLI entry point
fixtures/        committed deterministic series used by --fixture mode
tests/           vitest suites (deterministic) + live smoke tests
```

## License

MIT © Michael Mann
