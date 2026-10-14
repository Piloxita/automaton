/**
 * Tick Context
 *
 * Builds a shared context for each heartbeat tick.
 * Fetches credit balance ONCE per tick, derives survival tier,
 * and shares across all tasks to avoid redundant API calls.
 */

import type BetterSqlite3 from "better-sqlite3";

import type {
  ConwayClient,
  HeartbeatConfig,
  TickContext,
} from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import { readSelfhostedBalanceCents } from "../survival/selfhosted-balance.js";
import { createLogger } from "../observability/logger.js";
import type { ChainType } from "../identity/chain.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.tick");

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

/**
 * Build a TickContext for the current tick.
 *
 * - Generates a unique tickId
 * - Fetches credit balance ONCE via conway.getCreditsBalance()
 * - Fetches USDC balance ONCE via getUsdcBalance()
 * - Derives survivalTier from credit balance
 * - Reads lowComputeMultiplier from config
 */
export async function buildTickContext(
  db: DatabaseType,
  conway: ConwayClient,
  config: HeartbeatConfig,
  walletAddress?: string,
  chainType?: string,
  hostingMode?: "conway" | "selfhosted",
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  // Fetch balances ONCE
  let creditBalance = 0;
  let creditBalanceKnown = true;
  let usdcBalance = 0;

  if (hostingMode === "selfhosted") {
    // Self-hosted mode: there is no Conway credits balance. The agent's
    // "credits" ARE its USDC balance (in cents). An RPC failure must never
    // read as a zero balance — keep the last known reading and flag it as
    // unknown so heartbeat tasks never trigger death on a transient failure.
    if (walletAddress) {
      const reading = await readSelfhostedBalanceCents(walletAddress, chainType as ChainType | undefined);
      creditBalance = reading.cents;
      creditBalanceKnown = reading.known;
      if (!reading.known) {
        logger.error("Failed to read self-hosted USDC balance; using last known value");
      }
    } else {
      creditBalanceKnown = false;
    }
    usdcBalance = creditBalance / 100;
  } else {
    try {
      creditBalance = await conway.getCreditsBalance();
    } catch (err: any) {
      logger.error("Failed to fetch credit balance", err instanceof Error ? err : undefined);
    }

    if (walletAddress) {
      try {
        const network = chainType === "solana" ? "solana:mainnet" : "eip155:8453";
        usdcBalance = await getUsdcBalance(walletAddress, network, chainType as any);
      } catch (err: any) {
        logger.error("Failed to fetch USDC balance", err instanceof Error ? err : undefined);
      }
    }
  }

  const survivalTier = getSurvivalTier(creditBalance);
  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    creditBalance,
    creditBalanceKnown,
    usdcBalance,
    survivalTier,
    lowComputeMultiplier,
    config,
    db,
  };
}
