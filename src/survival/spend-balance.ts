/**
 * Balance provider for the SpendGuard: tells it how much of the asset a spend
 * kind draws on is left (USDC for x402/topup, Conway credits for transfers).
 * Returns null when the balance cannot be read, which makes the guard deny.
 */

import type { ConwayClient } from "../types.js";
import type { ChainType } from "../identity/chain.js";
import type { BalanceProvider, SpendKind } from "./spend-guard.js";
import { getUsdcBalanceDetailed } from "../conway/x402.js";

export function createBalanceProvider(params: {
  conway: Pick<ConwayClient, "getCreditsBalance">;
  address: string;
  chainType?: ChainType;
  /** Self-hosted mode has no Conway credits — every kind draws on the USDC balance. */
  hostingMode?: "conway" | "selfhosted";
}): BalanceProvider {
  const { conway, address, chainType, hostingMode } = params;
  const selfhosted = hostingMode === "selfhosted";
  const usdcCents = async (): Promise<number | null> => {
    if (chainType === "solana") return null;
    const usdc = await getUsdcBalanceDetailed(address as `0x${string}`);
    return usdc.ok ? Math.floor(usdc.balance * 100) : null;
  };
  return async (kind: SpendKind): Promise<number | null> => {
    switch (kind) {
      case "x402":
      case "topup":
        return usdcCents();
      case "transfer":
      case "fund_child":
      case "orchestrator_fund": {
        if (selfhosted) return usdcCents();
        const credits = await conway.getCreditsBalance();
        return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? credits : null;
      }
      case "gas":
        return null;
    }
  };
}
