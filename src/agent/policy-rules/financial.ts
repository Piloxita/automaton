/**
 * Financial Policy Rules
 *
 * Enforces spend limits, domain allowlists, and transfer caps
 * to prevent iterative credit drain and unauthorized payments.
 */

import { getSpendGuard, type SpendKind } from "../../survival/spend-guard.js";
import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
  TreasuryPolicy,
} from "../../types.js";

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Spend kind and amount (cents) a tool call would move, when knowable from its args.
 * x402 amounts come from the server's 402 response, so only a 1-cent probe is possible here;
 * the exact amount is enforced inside x402Fetch via the SpendGuard.
 */
function spendProbe(request: PolicyRequest): { kind: SpendKind; amountCents: number } | null {
  switch (request.tool.name) {
    case "transfer_credits":
      return typeof request.args.amount_cents === "number"
        ? { kind: "transfer", amountCents: request.args.amount_cents }
        : null;
    case "fund_child":
      return typeof request.args.amount_cents === "number"
        ? { kind: "fund_child", amountCents: request.args.amount_cents }
        : null;
    case "topup_credits":
      return typeof request.args.amount_usd === "number"
        ? { kind: "topup", amountCents: request.args.amount_usd * 100 }
        : null;
    case "x402_fetch":
      return { kind: "x402", amountCents: 1 };
    default:
      return null;
  }
}

/**
 * x402 payments above the per-payment max. The amount is only known after the server's
 * 402 reply, so x402Fetch enforces it with the SpendGuard; this rule denies up front when
 * x402 is disabled (max <= 0) or the hourly/daily envelope is already exhausted.
 */
function createX402MaxSingleRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.x402_max_single",
    description: `Deny x402 payments above ${policy.maxX402PaymentCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: ["x402_fetch"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (policy.maxX402PaymentCents <= 0) {
        return deny(
          "financial.x402_max_single",
          "SPEND_LIMIT_EXCEEDED",
          "x402 payments are disabled (maxX402PaymentCents is 0)",
        );
      }
      const guard = getSpendGuard();
      if (!guard) return null;
      const check = guard.preview("x402", 1);
      if (!check.allowed && check.code && check.code !== "RESERVE_VIOLATION") {
        return deny("financial.x402_max_single", "SPEND_LIMIT_EXCEEDED", check.reason ?? "x402 spend cap reached");
      }
      return null;
    },
  };
}

/**
 * Deny x402 requests to domains not in the allowlist.
 */
function createX402DomainAllowlistRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.x402_domain_allowlist",
    description: "Deny x402 to domains not in allowlist",
    priority: 500,
    appliesTo: { by: "name", names: ["x402_fetch"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const url = request.args.url as string | undefined;
      if (!url) return null;

      const allowedDomains = policy.x402AllowedDomains;
      if (allowedDomains.length === 0) {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          "x402 payments are disabled (empty allowlist)",
        );
      }

      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          `Invalid URL: ${url}`,
        );
      }

      const isAllowed = allowedDomains.some(
        (domain) =>
          hostname === domain || hostname.endsWith(`.${domain}`),
      );

      if (!isAllowed) {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          `Domain "${hostname}" not in x402 allowlist: [${allowedDomains.join(", ")}]`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny single transfers above the configured max.
 */
function createTransferMaxSingleRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_max_single",
    description: `Deny transfers above ${policy.maxSingleTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      if (amount > policy.maxSingleTransferCents) {
        return deny(
          "financial.transfer_max_single",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer of ${amount} cents exceeds single transfer max of ${policy.maxSingleTransferCents} cents ($${(policy.maxSingleTransferCents / 100).toFixed(2)})`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if hourly transfer total would exceed cap.
 */
function createTransferHourlyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_hourly_cap",
    description: `Deny if hourly transfers exceed ${policy.maxHourlyTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Hourly")) {
        return deny(
          "financial.transfer_hourly_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed hourly cap: current ${check.currentHourlySpend} + ${amount} > ${check.limitHourly} cents ($${(check.limitHourly / 100).toFixed(2)}/hr)`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if daily transfer total would exceed cap.
 */
function createTransferDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_daily_cap",
    description: `Deny if daily transfers exceed ${policy.maxDailyTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Daily")) {
        return deny(
          "financial.transfer_daily_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed daily cap: current ${check.currentDailySpend} + ${amount} > ${check.limitDaily} cents ($${(check.limitDaily / 100).toFixed(2)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny any financial operation that would bring balance below minimum reserve.
 * Uses the SpendGuard's most recent balance reading; when no reading exists the
 * guard itself denies at execution time (unknown balance fails closed).
 */
function createMinimumReserveRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.minimum_reserve",
    description: `Deny if balance would drop below ${policy.minimumReserveCents} cents reserve`,
    priority: 500,
    appliesTo: {
      by: "name",
      names: ["transfer_credits", "x402_fetch", "fund_child", "topup_credits"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const probe = spendProbe(request);
      const guard = getSpendGuard();
      if (!probe || !guard) return null;
      const check = guard.preview(probe.kind, probe.amountCents);
      if (!check.allowed && check.code === "RESERVE_VIOLATION") {
        return deny("financial.minimum_reserve", "MINIMUM_RESERVE", check.reason ?? "minimum reserve would be violated");
      }
      return null;
    },
  };
}

/**
 * Deny child funding and credit top-ups that exceed the SpendGuard caps.
 * (Transfers and x402 have their own rules above.)
 */
function createGuardCapsRule(_policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.guard_caps",
    description: "Deny fund_child / topup_credits above the treasury caps",
    priority: 500,
    appliesTo: { by: "name", names: ["fund_child", "topup_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const probe = spendProbe(request);
      const guard = getSpendGuard();
      if (!probe || !guard) return null;
      const check = guard.preview(probe.kind, probe.amountCents);
      if (!check.allowed && check.code !== "RESERVE_VIOLATION") {
        return deny("financial.guard_caps", "SPEND_LIMIT_EXCEEDED", check.reason ?? "spend cap exceeded");
      }
      return null;
    },
  };
}

/**
 * Deny if too many transfer operations in a single turn.
 * Prevents iterative credit drain within one turn.
 */
function createTurnTransferLimitRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.turn_transfer_limit",
    description: `Deny more than ${policy.maxTransfersPerTurn} transfers per turn`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const count = request.turnContext.turnToolCallCount;

      if (count >= policy.maxTransfersPerTurn) {
        return deny(
          "financial.turn_transfer_limit",
          "TURN_TRANSFER_LIMIT",
          `Maximum ${policy.maxTransfersPerTurn} transfers per turn exceeded (current: ${count})`,
        );
      }

      return null;
    },
  };
}

/**
 * Once the day's inference spend (read from the real meter, inference_costs) reaches
 * maxInferenceDailyCents, deny every tool that is not read-only. Inference is not a tool
 * call, so the rule has to apply to all tools.
 */
function createInferenceDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.inference_daily_cap",
    description: `Deny non-safe tools if daily inference cost exceeds ${policy.maxInferenceDailyCents} cents`,
    priority: 500,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (request.tool.riskLevel === "safe") return null;

      const spendTracker = request.turnContext.sessionSpend;
      const dailyInferenceSpend = spendTracker.getDailySpend("inference");

      if (dailyInferenceSpend >= policy.maxInferenceDailyCents) {
        return deny(
          "financial.inference_daily_cap",
          "INFERENCE_BUDGET_EXCEEDED",
          `Daily inference budget exceeded: ${dailyInferenceSpend} cents spent (max ${policy.maxInferenceDailyCents} cents / $${(policy.maxInferenceDailyCents / 100).toFixed(2)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Return 'quarantine' (not deny) for transfer amounts above
 * requireConfirmationAboveCents. This is a soft limit requiring confirmation.
 */
function createRequireConfirmationRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.require_confirmation",
    description: `Quarantine transfers above ${policy.requireConfirmationAboveCents} cents for confirmation`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      if (amount > policy.requireConfirmationAboveCents) {
        return {
          rule: "financial.require_confirmation",
          action: "quarantine",
          reasonCode: "CONFIRMATION_REQUIRED",
          humanMessage: `Transfer of ${amount} cents ($${(amount / 100).toFixed(2)}) exceeds confirmation threshold of ${policy.requireConfirmationAboveCents} cents ($${(policy.requireConfirmationAboveCents / 100).toFixed(2)})`,
        };
      }

      return null;
    },
  };
}

/**
 * Create all financial policy rules.
 */
export function createFinancialRules(
  treasuryPolicy: TreasuryPolicy,
): PolicyRule[] {
  return [
    createX402MaxSingleRule(treasuryPolicy),
    createX402DomainAllowlistRule(treasuryPolicy),
    createTransferMaxSingleRule(treasuryPolicy),
    createTransferHourlyCapRule(treasuryPolicy),
    createTransferDailyCapRule(treasuryPolicy),
    createMinimumReserveRule(treasuryPolicy),
    createGuardCapsRule(treasuryPolicy),
    createTurnTransferLimitRule(treasuryPolicy),
    createInferenceDailyCapRule(treasuryPolicy),
    createRequireConfirmationRule(treasuryPolicy),
  ];
}
