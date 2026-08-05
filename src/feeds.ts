/**
 * FTSOv2 on-chain feed client for Flare.
 *
 * FTSOv2 stores each feed as a `bytes21` id — `0x01` + ASCII symbol + zero
 * padding — readable with a single `getFeedByIdInWei` view call. Prices come
 * back with 18 decimals. We read directly from the `FtsoV2` contract on chain
 * (resolved via the Flare `ContractRegistry`, with a stable mainnet fallback)
 * so no external HTTP API is required.
 */

import { Contract, JsonRpcProvider, ZeroAddress, isAddress } from 'ethers';

export const FLARE_RPC_URL = 'https://flare-api.flare.network/ext/C/rpc';
export const FLARE_CHAIN_ID = 14;
export const CONTRACT_REGISTRY_ADDRESS = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
/** Stable mainnet address of the FTSOv2 contract (used when the registry is unreachable). */
export const FTSO_V2_ADDRESS = '0x7BDE3Df0624114eDB3A67dFe6753e62f4e7c1d20';
export const FTSO_DECIMALS = 18;

/** Feeds bundled with fixture data. Any 1–20 byte ASCII symbol can be read live. */
export const KNOWN_SYMBOLS = [
  'FLR/USD',
  'BTC/USD',
  'ETH/USD',
  'XRP/USD',
  'DOGE/USD',
  'SOL/USD',
] as const;

const REGISTRY_ABI = [
  'function nameToAddress(string calldata name) external view returns (address)',
];
const FTSO_V2_ABI = [
  'function getFeedByIdInWei(bytes21 feedId) view returns (uint256 value, uint64 timestamp)',
];

export interface FeedSample {
  symbol: string;
  price: number;
  /** Unix timestamp in seconds, as reported by the oracle. */
  timestamp: number;
}

/** The read surface the rest of the tool depends on (injectable for tests). */
export interface FeedReader {
  read(symbol: string): Promise<FeedSample>;
  readonly rpcUrl: string;
}

/** Minimal on-chain feed surface; stubbed in tests to avoid any network I/O. */
export interface OnChainFeed {
  getFeedByIdInWei(feedId: string): Promise<{ value: bigint; timestamp: bigint }>;
}

/** Build the FTSOv2 `bytes21` feed id for a symbol such as "FLR/USD". */
export function feedIdForSymbol(symbol: string): string {
  const body = Buffer.from(symbol, 'ascii');
  if (body.length === 0 || body.length > 20) {
    throw new Error(`feed symbol must be 1-20 ASCII characters, got "${symbol}"`);
  }
  return `0x01${body.toString('hex').padEnd(40, '0')}`;
}

/**
 * Convert an 18-decimal wei integer to a JS number without going through
 * `Number(bigint)` (which would lose precision above 2^53).
 */
export function weiToNumber(wei: bigint, decimals = FTSO_DECIMALS): number {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const s = abs.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals);
  const value = Number(`${intPart}.${fracPart}`);
  return negative ? -value : value;
}

/** Resolve the FtsoV2 contract address via the Flare ContractRegistry. */
export async function resolveFtsoV2Address(provider: JsonRpcProvider): Promise<string> {
  try {
    const registry = new Contract(CONTRACT_REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    const address = await registry.nameToAddress('FtsoV2');
    if (typeof address === 'string' && isAddress(address) && address !== ZeroAddress) {
      return address;
    }
  } catch {
    // Registry unreachable — fall back to the stable mainnet address.
  }
  return FTSO_V2_ADDRESS;
}

export class EthersFeedReader implements FeedReader {
  readonly rpcUrl: string;
  private readonly onChain: OnChainFeed;
  private contractPromise: Promise<Contract> | null = null;

  constructor(rpcUrl: string, onChain?: OnChainFeed) {
    this.rpcUrl = rpcUrl;
    this.onChain =
      onChain ??
      ({
        getFeedByIdInWei: async (feedId: string) => {
          const contract = await this.ftsoV2Contract();
          const [value, timestamp] = await contract.getFeedByIdInWei(feedId);
          return { value: BigInt(value), timestamp: BigInt(timestamp) };
        },
      } satisfies OnChainFeed);
  }

  private async ftsoV2Contract(): Promise<Contract> {
    if (!this.contractPromise) {
      this.contractPromise = (async () => {
        const provider = new JsonRpcProvider(this.rpcUrl);
        const address = await resolveFtsoV2Address(provider);
        return new Contract(address, FTSO_V2_ABI, provider);
      })();
    }
    return this.contractPromise;
  }

  async read(symbol: string): Promise<FeedSample> {
    const feedId = feedIdForSymbol(symbol);
    const { value, timestamp } = await this.onChain.getFeedByIdInWei(feedId);
    if (value === 0n) {
      throw new Error(`no feed data for "${symbol}" (feed id ${feedId}) — is the symbol an active FTSOv2 feed?`);
    }
    return { symbol, price: weiToNumber(value), timestamp: Number(timestamp) };
  }
}

/** Factory honoring `FLARE_RPC_URL` (falls back to the verified public endpoint). */
export function createFeedReader(rpcUrl?: string): FeedReader {
  const url = rpcUrl ?? process.env.FLARE_RPC_URL ?? FLARE_RPC_URL;
  return new EthersFeedReader(url);
}
