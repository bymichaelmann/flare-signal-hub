/**
 * Live smoke tests against a real Flare RPC endpoint.
 *
 * Skipped by default — they only run when the LIVE_RPC environment variable
 * is set (e.g. in CI's live job, which is gated on the LIVE_RPC secret).
 */

import { describe, expect, it } from 'vitest';
import { KNOWN_SYMBOLS, createFeedReader } from '../src/feeds.js';

const LIVE = process.env.LIVE_RPC;

describe.skipIf(!LIVE)('live FTSOv2 feeds (LIVE_RPC set)', () => {
  const reader = createFeedReader(LIVE);

  it('reads FLR/USD from mainnet', async () => {
    const sample = await reader.read('FLR/USD');
    expect(sample.price).toBeGreaterThan(0);
    expect(sample.timestamp).toBeGreaterThan(1_700_000_000);
  });

  it('reads every known symbol', async () => {
    for (const symbol of KNOWN_SYMBOLS) {
      const sample = await reader.read(symbol);
      expect(sample.price).toBeGreaterThan(0);
      expect(sample.symbol).toBe(symbol);
    }
  }, 30_000);

  it('resolves the FtsoV2 contract via the registry', async () => {
    const { JsonRpcProvider } = await import('ethers');
    const { resolveFtsoV2Address, FTSO_V2_ADDRESS } = await import('../src/feeds.js');
    const provider = new JsonRpcProvider(LIVE);
    const address = await resolveFtsoV2Address(provider);
    expect(address.toLowerCase()).toBe(FTSO_V2_ADDRESS.toLowerCase());
  }, 30_000);
});
