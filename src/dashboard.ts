/**
 * Self-contained HTML dashboard.
 *
 * Renders the latest signals for every watched symbol plus SVG sparklines of
 * the underlying series. All CSS and JS is inlined — no CDN, no external
 * requests, works from `file://` or any static host.
 */

import type { SignalResult } from './signals.js';
import { formatPrice } from './signals.js';

export interface DashboardData {
  generatedAt: string;
  mode: string;
  symbols: DashboardSymbol[];
}

export interface DashboardSymbol {
  symbol: string;
  price: number;
  signal: string;
  confidence: number;
  score: number;
  dataSufficient: boolean;
  indicators: Record<string, number | null>;
  reasoning: string[];
  series: number[];
}

export function buildDashboardData(
  reports: SignalResult[],
  seriesBySymbol: Record<string, number[]>,
  mode: string,
  generatedAt?: string,
): DashboardData {
  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    mode,
    symbols: reports.map((r) => ({
      symbol: r.symbol,
      price: r.price,
      signal: r.signal,
      confidence: r.confidence,
      score: r.score,
      dataSufficient: r.dataSufficient,
      indicators: {
        'SMA(20)': r.indicators.sma20,
        'EMA(20)': r.indicators.ema20,
        'RSI(14)': r.indicators.rsi14,
        'MACD': r.indicators.macd,
        'MACD signal': r.indicators.macdSignal,
        'MACD hist': r.indicators.macdHistogram,
      },
      reasoning: r.reasoning,
      series: seriesBySymbol[r.symbol] ?? [],
    })),
  };
}

/**
 * Escape a string so it is safe inside a <script> block. JSON.stringify may
 * emit literal "</script>" sequences when data contains "</", so `<` is
 * rewritten to its unicode escape.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderDashboard(data: DashboardData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flare Signal Hub — FTSOv2 signal monitor</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel-2: #1c2330; --text: #e6edf3;
    --muted: #8b949e; --line: #30363d; --accent: #f5a623;
    --buy: #2ea043; --sell: #f85149; --hold: #8b949e;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); }
  header { padding: 24px 28px 16px; border-bottom: 1px solid var(--line); }
  header h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .3px; }
  header h1 span { color: var(--accent); }
  header .sub { color: var(--muted); font-size: 13px; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .controls button { background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
                     border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px; }
  .controls button.active { border-color: var(--accent); color: var(--accent); }
  main { padding: 24px 28px; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
  .card.hidden { display: none; }
  .card .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .card .sym { font-weight: 600; font-size: 15px; }
  .card .price { font-size: 20px; font-weight: 600; margin: 2px 0 6px; }
  .badge { border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 700; letter-spacing: .6px; }
  .badge.BUY { background: rgba(46,160,67,.18); color: var(--buy); }
  .badge.SELL { background: rgba(248,81,73,.18); color: var(--sell); }
  .badge.HOLD { background: rgba(139,148,158,.18); color: var(--hold); }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .conf { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .conf .bar { flex: 1; height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; }
  .conf .bar > i { display: block; height: 100%; border-radius: 3px; }
  .conf.BUY .bar > i { background: var(--buy); }
  .conf.SELL .bar > i { background: var(--sell); }
  .conf.HOLD .bar > i { background: var(--hold); }
  .spark { display: block; margin: 4px 0 10px; }
  .indicators { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; font-size: 12px; margin-bottom: 10px; }
  .indicators div { display: flex; justify-content: space-between; border-bottom: 1px dotted var(--line); padding: 2px 0; }
  .indicators span { color: var(--muted); }
  .reasoning { list-style: none; margin: 0; padding: 0; font-size: 12px; color: var(--muted); }
  .reasoning li { padding: 2px 0; }
  footer { padding: 16px 28px 28px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
  .tag { color: var(--accent); }
  body.light { --bg: #f6f8fa; --panel: #ffffff; --panel-2: #eaeef2; --text: #1f2328;
               --muted: #59636e; --line: #d1d9e0; }
</style>
</head>
<body>
<header>
  <h1>Flare <span>Signal Hub</span></h1>
  <div class="sub">Explainable BUY / HOLD / SELL signals from FTSOv2 price feeds on Flare · generated <span id="generated"></span> · mode <span class="tag" id="mode"></span></div>
  <div class="controls">
    <button data-filter="ALL" class="active">All</button>
    <button data-filter="BUY">BUY</button>
    <button data-filter="SELL">SELL</button>
    <button data-filter="HOLD">HOLD</button>
    <button id="theme">Light / Dark</button>
  </div>
</header>
<main id="cards"></main>
<footer>
  Data source: FTSOv2 on-chain price feeds, Flare mainnet (chain 14), read directly via
  <code>FtsoV2.getFeedByIdInWei</code>. Signals are deterministic technical-analysis output —
  informational only, not financial advice.
</footer>
<script>
"use strict";
var DATA = ${safeJson(data)};

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function fmtPrice(p) {
  var a = Math.abs(p);
  if (a >= 1000) return p.toFixed(2);
  if (a >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

function sparkline(svg, series, w, h) {
  if (!series || series.length < 2) return;
  var min = Infinity, max = -Infinity;
  series.forEach(function (p) { if (p < min) min = p; if (p > max) max = p; });
  var span = (max - min) || 1;
  var step = (w - 4) / (series.length - 1);
  var pts = series.map(function (p, i) {
    return (2 + i * step).toFixed(1) + "," + (h - 4 - ((p - min) / span) * (h - 8)).toFixed(1);
  }).join(" ");
  var poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", pts);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "var(--accent)");
  poly.setAttribute("stroke-width", "1.5");
  svg.appendChild(poly);
}

function card(s) {
  var c = el("div", "card");
  var head = el("div", "head");
  head.appendChild(el("div", "sym", s.symbol));
  head.appendChild(el("span", "badge " + s.signal, s.signal));
  c.appendChild(head);
  c.appendChild(el("div", "price", fmtPrice(s.price)));
  c.appendChild(el("div", "meta", "score " + (s.score >= 0 ? "+" : "") + s.score.toFixed(3) +
    " · " + s.series.length + " samples" + (s.dataSufficient ? "" : " · short history")));

  var conf = el("div", "conf " + s.signal);
  var bar = el("div", "bar");
  var fill = document.createElement("i");
  fill.style.width = Math.max(2, Math.min(100, s.confidence)) + "%";
  bar.appendChild(fill);
  conf.appendChild(bar);
  conf.appendChild(el("span", null, s.confidence + "%"));
  c.appendChild(conf);

  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("width", "300");
  svg.setAttribute("height", "56");
  svg.setAttribute("viewBox", "0 0 300 56");
  sparkline(svg, s.series, 300, 56);
  c.appendChild(svg);

  var grid = el("div", "indicators");
  Object.keys(s.indicators).forEach(function (k) {
    var row = el("div");
    row.appendChild(el("span", null, k));
    var v = s.indicators[k];
    row.appendChild(el("span", null, v === null ? "n/a" : v.toPrecision(6)));
    grid.appendChild(row);
  });
  c.appendChild(grid);

  var list = el("ul", "reasoning");
  s.reasoning.forEach(function (line) { list.appendChild(el("li", null, line)); });
  c.appendChild(list);
  return c;
}

function render(filter) {
  var main = document.getElementById("cards");
  main.textContent = "";
  DATA.symbols.forEach(function (s) {
    if (filter && filter !== "ALL" && s.signal !== filter) return;
    main.appendChild(card(s));
  });
}

document.getElementById("generated").textContent = new Date(DATA.generatedAt).toLocaleString();
document.getElementById("mode").textContent = DATA.mode;

var activeFilter = "ALL";
document.querySelectorAll("[data-filter]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    activeFilter = btn.getAttribute("data-filter");
    document.querySelectorAll("[data-filter]").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
    render(activeFilter);
  });
});
document.getElementById("theme").addEventListener("click", function () {
  document.body.classList.toggle("light");
});

render("ALL");
</script>
</body>
</html>
`;
}
