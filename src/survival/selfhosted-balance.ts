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
 *
 * Prepaid inference credit counts as money too: when the inference endpoint
 * is OpenRouter and its key has a credit limit, the remaining credit is added
 * (an agent with $0 USDC but $10 of inference credit is not "critical").
 */

import { getUsdcBalance, getUsdcBalanceDetailed } from "../conway/x402.js";
import type { ChainType } from "../identity/chain.js";

export interface SelfhostedBalanceReading {
  /** USDC + prepaid inference credit, in cents. A live reading when `known` is true, else last known values. */
  cents: number;
  /** False when the USDC part is stale (the live read failed). */
  known: boolean;
  /** On-chain USDC part, in cents. */
  usdcCents: number;
  /** Remaining prepaid inference credit, in cents (0 if not applicable or unknown). */
  inferenceCreditCents: number;
}

let lastKnownCents: number | null = null;

interface InferenceCreditSource {
  baseUrl: string;
  apiKeyEnv: string;
}

let creditSource: InferenceCreditSource | null = null;
let lastCredit: { cents: number; at: number } | null = null;
const CREDIT_TTL_MS = 5 * 60_000;

/** Called at startup in self-hosted mode with config.openaiCompatible. */
export function setInferenceCreditSource(source: InferenceCreditSource | null | undefined): void {
  creditSource = source && /(^|\.)openrouter\.ai$/.test(safeHost(source.baseUrl)) ? source : null;
  lastCredit = null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Remaining OpenRouter credit for the configured key, in cents. Keys without a
 * credit limit report null remaining: that counts as 0 here, so the creator
 * should set a limit on the key. Failures return the last known value.
 */
export async function readInferenceCreditCents(fetchFn: typeof fetch = fetch): Promise<number> {
  if (!creditSource) return 0;
  if (lastCredit && Date.now() - lastCredit.at < CREDIT_TTL_MS) return lastCredit.cents;
  const key = process.env[creditSource.apiKeyEnv];
  if (!key) return 0;
  try {
    const resp = await fetchFn("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return lastCredit?.cents ?? 0;
    const body = (await resp.json()) as { data?: { limit_remaining?: number | null } };
    const remaining = body.data?.limit_remaining;
    const cents = typeof remaining === "number" && remaining > 0 ? Math.floor(remaining * 100) : 0;
    lastCredit = { cents, at: Date.now() };
    return cents;
  } catch {
    return lastCredit?.cents ?? 0;
  }
}

async function withCredit(usdcCents: number, known: boolean): Promise<SelfhostedBalanceReading> {
  const inferenceCreditCents = await readInferenceCreditCents();
  return { cents: usdcCents + inferenceCreditCents, known, usdcCents, inferenceCreditCents };
}

export async function readSelfhostedBalanceCents(
  address: string,
  chainType?: ChainType,
): Promise<SelfhostedBalanceReading> {
  if (chainType === "solana") {
    try {
      const usdc = await getUsdcBalance(address, "solana:mainnet", "solana");
      const cents = Math.round(usdc * 100);
      lastKnownCents = cents;
      return withCredit(cents, true);
    } catch {
      return withCredit(lastKnownCents ?? 0, false);
    }
  }

  const result = await getUsdcBalanceDetailed(address as `0x${string}`);
  if (result.ok) {
    const cents = Math.round(result.balance * 100);
    lastKnownCents = cents;
    return withCredit(cents, true);
  }
  return withCredit(lastKnownCents ?? 0, false);
}

/** Test-only: clear the module-level "last known balance" cache between test cases. */
export function resetSelfhostedBalanceCacheForTests(): void {
  lastKnownCents = null;
  creditSource = null;
  lastCredit = null;
}
