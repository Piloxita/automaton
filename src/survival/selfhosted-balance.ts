/**
 * Self-hosted balance reading.
 *
 * In self-hosted mode there is no Conway credits balance: the agent's "money"
 * is its on-chain USDC balance, expressed in cents everywhere the rest of the
 * codebase expects a credits-cents number (survival tiers, system prompt,
 * heartbeat tasks, SpendGuard, ...).
 *
 * An RPC failure must never read as "balance is zero" (that would trigger
 * death escalation on a transient network blip). Instead we keep the last
 * known good reading in a module-level cache and report `known: false` so
 * callers can skip death/critical-escalation logic for that tick.
 */

import { getUsdcBalance, getUsdcBalanceDetailed } from "../conway/x402.js";
import type { ChainType } from "../identity/chain.js";

export interface SelfhostedBalanceReading {
  /** USDC balance in cents — a live reading when `known` is true, else the last known value (or 0 if none yet). */
  cents: number;
  /** False when this reading is stale (the live read failed). */
  known: boolean;
}

let lastKnownCents: number | null = null;

export async function readSelfhostedBalanceCents(
  address: string,
  chainType?: ChainType,
): Promise<SelfhostedBalanceReading> {
  if (chainType === "solana") {
    try {
      const usdc = await getUsdcBalance(address, "solana:mainnet", "solana");
      const cents = Math.round(usdc * 100);
      lastKnownCents = cents;
      return { cents, known: true };
    } catch {
      return { cents: lastKnownCents ?? 0, known: false };
    }
  }

  const result = await getUsdcBalanceDetailed(address as `0x${string}`);
  if (result.ok) {
    const cents = Math.round(result.balance * 100);
    lastKnownCents = cents;
    return { cents, known: true };
  }
  return { cents: lastKnownCents ?? 0, known: false };
}

/** Test-only: clear the module-level "last known balance" cache between test cases. */
export function resetSelfhostedBalanceCacheForTests(): void {
  lastKnownCents = null;
}
