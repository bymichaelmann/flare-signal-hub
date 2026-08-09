import { describe, expect, it } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import {
  FTSO_V2_ADDRESS,
  EthersFeedReader,
  feedIdForSymbol,
  resolveFtsoV2Address,
  weiToNumber,
} from '../src/feeds.js';

describe('feedIdForSymbol', () => {
  it('builds the FLR/USD bytes21 feed id', () => {
    expect(feedIdForSymbol('FLR/USD')).toBe('0x01464c522f55534400000000000000000000000000');
  });

  it('builds the BTC/USD bytes21 feed id', () => {
    expect(feedIdForSymbol('BTC/USD')).toBe('0x014254432f55534400000000000000000000000000');
  });

  it('builds the ETH/USD bytes21 feed id', () => {
    expect(feedIdForSymbol('ETH/USD')).toBe('0x014554482f55534400000000000000000000000000');
  });

  it('rejects symbols longer than 20 bytes', () => {
    expect(() => feedIdForSymbol('A'.repeat(21))).toThrow();
  });
});

describe('weiToNumber', () => {
  it('converts the FLR price (18 decimals) to decimal', () => {
    expect(weiToNumber(5997000000000000n)).toBeCloseTo(0.005997, 12);
  });

  it('converts the BTC price (18 decimals) to decimal', () => {
    expect(weiToNumber(64439490000000000000000n)).toBeCloseTo(64439.49, 6);
  });

  it('handles zero', () => {
    expect(weiToNumber(0n)).toBe(0);
  });

  it('handles sub-unit values without losing precision', () => {
    expect(weiToNumber(123456789012345678n)).toBeCloseTo(0.12345678901234568, 12);
  });

  it('handles negative wei', () => {
    expect(weiToNumber(-5997000000000000n)).toBeCloseTo(-0.005997, 12);
  });
});

describe('EthersFeedReader with a stub on-chain feed (no network)', () => {
  const canned = { value: 5997000000000000n, timestamp: 1785939145n };
  const reader = new EthersFeedReader('http://stub.invalid', {
    getFeedByIdInWei: async (id) =>
      id === feedIdForSymbol('FLR/USD') ? canned : { value: 0n, timestamp: 0n },
  });

  it('reads a canned feed and converts wei → decimal price', async () => {
    const sample = await reader.read('FLR/USD');
    expect(sample.price).toBeCloseTo(0.005997, 12);
    expect(sample.timestamp).toBe(1785939145);
    expect(sample.symbol).toBe('FLR/USD');
  });

  it('surfaces the rpcUrl', () => {
    expect(reader.rpcUrl).toBe('http://stub.invalid');
  });

  it('passes the exact bytes21 id to the on-chain call', async () => {
    let seen = '';
    const spy = new EthersFeedReader('http://stub.invalid', {
      getFeedByIdInWei: async (id) => {
        seen = id;
        return { value: 1n, timestamp: 1n };
      },
    });
    await spy.read('BTC/USD');
    expect(seen).toBe('0x014254432f55534400000000000000000000000000');
  });

  it('throws a clear error when the feed returns zero', async () => {
    const empty = new EthersFeedReader('http://stub.invalid', {
      getFeedByIdInWei: async () => ({ value: 0n, timestamp: 0n }),
    });
    await expect(empty.read('NOPE/USD')).rejects.toThrow(/no feed data/i);
  });
});

describe('resolveFtsoV2Address', () => {
  it('falls back to the stable mainnet address when the registry is unreachable', async () => {
    // 127.0.0.1:1 is unroutable; no network request can succeed.
    const provider = new JsonRpcProvider('http://127.0.0.1:1');
    await expect(resolveFtsoV2Address(provider)).resolves.toBe(FTSO_V2_ADDRESS);
  });

  it('uses an address returned by the registry', async () => {
    // Stub provider that answers every eth_call with a 32-byte word holding
    // address 0x2222...22 — ethers ABI-decodes it as the registry result.
    const resolved = '0x' + '22'.repeat(20);
    class FakeProvider extends JsonRpcProvider {
      constructor() {
        super('http://127.0.0.1:1');
      }
      override async call(): Promise<string> {
        return '0x' + '00'.repeat(12) + '22'.repeat(20);
      }
    }
    await expect(resolveFtsoV2Address(new FakeProvider())).resolves.toBe(resolved.toLowerCase());
  });
});
