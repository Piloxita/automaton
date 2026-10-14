/**
 * SpendGuard
 *
 * Single chokepoint every money-moving code path must pass before moving value
 * (x402 payments, credit top-ups, credit transfers, child funding, orchestrator
 * funding, on-chain gas). Enforcement lives in code, not in prompts or regex:
 * the limits come from TreasuryPolicy (set by the human creator in config),
 * state lives in SQLite, and every decision is written to `spend_audit`.
 *
 * Flow: authorize() reserves the amount (it counts against caps immediately, so
 * concurrent callers cannot race past a cap) -> the caller moves the value ->
 * settle() records the REAL amount, or release() frees the reservation when no
 * value moved. Reservations that are never settled keep counting (fail closed).
 *
 * Fail-closed rules:
 *  - no guard installed            -> denied (authorizeSpend)
 *  - invalid / non-finite amount   -> denied
 *  - unknown balance               -> denied for every kind except `gas`
 *  - invalid policy numbers        -> replaced by defaults
 */

import { ulid } from "ulid";
import type Database from "better-sqlite3";
import type { SpendCategory, TreasuryPolicy } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("spend-guard");

export type SpendKind =
  | "x402"
  | "topup"
  | "transfer"
  | "fund_child"
  | "orchestrator_fund"
  | "gas";

export interface SpendRequest {
  kind: SpendKind;
  amountCents: number;
  recipient?: string;
  reason: string;
  /** Balance (cents) in the asset this kind spends. Overrides the balance provider. */
  balanceCents?: number | null;
}

export type SpendAuthorization =
  | { ok: true; ticket: string; kind: SpendKind; amountCents: number }
  | { ok: false; code: string; reason: string };

export type BalanceProvider = (kind: SpendKind) => Promise<number | null>;

interface KindLimits {
  single: number;
  hourly: number;
  daily: number;
}

const GUARD_TOOL_PREFIX = "guard:";

const KIND_CATEGORY: Record<SpendKind, SpendCategory> = {
  x402: "x402",
  transfer: "transfer",
  fund_child: "transfer",
  orchestrator_fund: "transfer",
  topup: "other",
  gas: "other",
};

/** Kinds that move Conway credits out of the wallet (share the transfer caps). */
const CREDIT_OUTFLOW_KINDS: SpendKind[] = ["transfer", "fund_child", "orchestrator_fund"];
const CHILD_FUNDING_KINDS: SpendKind[] = ["fund_child", "orchestrator_fund"];

/** Kinds whose balance must be known (and reserve respected) before spending. */
const BALANCE_REQUIRED_KINDS = new Set<SpendKind>([
  "x402",
  "topup",
  "transfer",
  "fund_child",
  "orchestrator_fund",
]);

export function normalizeTreasuryPolicy(policy?: Partial<TreasuryPolicy>): TreasuryPolicy {
  const merged: TreasuryPolicy = { ...DEFAULT_TREASURY_POLICY, ...(policy ?? {}) };
  for (const [key, value] of Object.entries(DEFAULT_TREASURY_POLICY)) {
    if (typeof value !== "number") continue;
    const v = (merged as unknown as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export function limitsForKind(policy: TreasuryPolicy, kind: SpendKind): KindLimits {
  switch (kind) {
    case "x402":
      return {
        single: policy.maxX402PaymentCents,
        hourly: policy.maxX402HourlyCents,
        daily: policy.maxX402DailyCents,
      };
    case "topup":
      return {
        single: policy.maxTopupSingleCents,
        hourly: policy.maxTopupHourlyCents,
        daily: policy.maxTopupDailyCents,
      };
    case "transfer":
      return {
        single: policy.maxSingleTransferCents,
        hourly: policy.maxHourlyTransferCents,
        daily: policy.maxDailyTransferCents,
      };
    case "fund_child":
    case "orchestrator_fund":
      return {
        single: policy.maxChildFundingSingleCents,
        hourly: policy.maxChildFundingHourlyCents,
        daily: policy.maxChildFundingDailyCents,
      };
    case "gas":
      return {
        single: policy.maxGasSingleCents,
        hourly: policy.maxGasHourlyCents,
        daily: policy.maxGasDailyCents,
      };
  }
}

function hourWindow(): string {
  return new Date().toISOString().slice(0, 13);
}

function dayWindow(): string {
  return new Date().toISOString().slice(0, 10);
}

export class SpendGuard {
  private readonly db: Database.Database;
  readonly policy: TreasuryPolicy;
  private readonly balanceProvider?: BalanceProvider;
  private readonly lastBalances = new Map<SpendKind, { cents: number; at: number }>();

  constructor(
    db: Database.Database,
    policy?: Partial<TreasuryPolicy>,
    balanceProvider?: BalanceProvider,
  ) {
    this.db = db;
    this.policy = normalizeTreasuryPolicy(policy);
    this.balanceProvider = balanceProvider;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spend_tracking (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        recipient TEXT,
        domain TEXT,
        category TEXT NOT NULL CHECK(category IN ('transfer','x402','inference','other')),
        window_hour TEXT NOT NULL,
        window_day TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_spend_hour ON spend_tracking(category, window_hour);
      CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_tracking(category, window_day);
      CREATE TABLE IF NOT EXISTS spend_audit (
        id TEXT PRIMARY KEY,
        ticket TEXT,
        kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        recipient TEXT,
        reason TEXT NOT NULL DEFAULT '',
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_spend_audit_kind ON spend_audit(kind, outcome);
    `);
  }

  // ─── Public API ───────────────────────────────────────────────

  /** Check limits and reserve the amount. Call settle()/release() afterwards. */
  async authorize(req: SpendRequest): Promise<SpendAuthorization> {
    const amount = this.normalizeAmount(req.amountCents);
    if (amount === null) {
      return this.deny(req, 0, "INVALID_AMOUNT", `Invalid spend amount: ${String(req.amountCents)}`);
    }

    let balance: number | null = null;
    if (BALANCE_REQUIRED_KINDS.has(req.kind) || req.balanceCents !== undefined) {
      balance = await this.resolveBalance(req);
    }

    // check + reserve is synchronous and wrapped in a transaction: no race between callers
    try {
      return this.db.transaction(() => {
        const denial = this.evaluate(req.kind, amount, balance);
        if (denial) return this.deny(req, amount, denial.code, denial.reason);
        const ticket = this.reserve(req, amount);
        this.audit(req, "authorized", amount, ticket);
        return { ok: true as const, ticket, kind: req.kind, amountCents: amount };
      })();
    } catch (err: any) {
      return this.deny(req, amount, "GUARD_ERROR", `Spend guard error: ${err?.message ?? String(err)}`);
    }
  }

  /** Record the REAL amount after value moved. Idempotent for unknown tickets. */
  settle(ticket: string, actualCents?: number, detail?: string): void {
    const row = this.db
      .prepare("SELECT tool_name, amount_cents, recipient FROM spend_tracking WHERE id = ?")
      .get(ticket) as { tool_name: string; amount_cents: number; recipient: string | null } | undefined;
    if (!row) return;
    const kind = row.tool_name.slice(GUARD_TOOL_PREFIX.length) as SpendKind;
    let amount = row.amount_cents;
    if (actualCents !== undefined) {
      const normalized = this.normalizeAmount(actualCents);
      if (normalized !== null) amount = normalized;
    }
    this.db.prepare("UPDATE spend_tracking SET amount_cents = ? WHERE id = ?").run(amount, ticket);
    this.audit(
      { kind, amountCents: amount, recipient: row.recipient ?? undefined, reason: "" },
      "settled",
      amount,
      ticket,
      detail ?? (amount !== row.amount_cents ? `reserved ${row.amount_cents}` : undefined),
    );
  }

  /** Free a reservation because no value moved. */
  release(ticket: string, why: string): void {
    const row = this.db
      .prepare("SELECT tool_name, amount_cents, recipient FROM spend_tracking WHERE id = ?")
      .get(ticket) as { tool_name: string; amount_cents: number; recipient: string | null } | undefined;
    if (!row) return;
    const kind = row.tool_name.slice(GUARD_TOOL_PREFIX.length) as SpendKind;
    this.db.prepare("UPDATE spend_tracking SET amount_cents = 0 WHERE id = ?").run(ticket);
    this.audit(
      { kind, amountCents: row.amount_cents, recipient: row.recipient ?? undefined, reason: "" },
      "released",
      row.amount_cents,
      ticket,
      why,
    );
  }

  /**
   * Synchronous, non-mutating check used by policy rules. Caps always apply;
   * the reserve applies only when a balance was seen recently (the execution-time
   * authorize() is the fail-closed enforcement).
   */
  preview(kind: SpendKind, amountCents: number): { allowed: boolean; code?: string; reason?: string } {
    const amount = this.normalizeAmount(amountCents);
    if (amount === null) return { allowed: false, code: "INVALID_AMOUNT", reason: `Invalid spend amount: ${amountCents}` };
    const cached = this.lastBalances.get(kind);
    const fresh = cached && Date.now() - cached.at < 10 * 60_000 ? cached.cents : null;
    const denial = this.evaluate(kind, amount, fresh, { balanceOptional: true });
    return denial ? { allowed: false, ...denial } : { allowed: true };
  }

  /** Credit-outflow operations authorized since the last persisted turn. */
  countTransfersThisTurn(): number {
    try {
      const marker = this.db.prepare("SELECT MAX(created_at) AS t FROM turns").get() as { t: string | null } | undefined;
      const since = marker?.t ?? "1970-01-01 00:00:00";
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM spend_tracking
           WHERE tool_name IN (${CREDIT_OUTFLOW_KINDS.map(() => "?").join(",")}) AND created_at >= ? AND amount_cents > 0`,
        )
        .get(...CREDIT_OUTFLOW_KINDS.map((k) => GUARD_TOOL_PREFIX + k), since) as { n: number };
      return row.n;
    } catch {
      // No turns table: count everything in the last hour (conservative)
      return this.sumRows(CREDIT_OUTFLOW_KINDS, "hour").count;
    }
  }

  getSpend(kind: SpendKind, window: "hour" | "day"): number {
    return this.sumRows([kind], window).total;
  }

  // ─── Internals ────────────────────────────────────────────────

  private normalizeAmount(amount: number): number | null {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
    // Fractional cents round UP: conservative, and keeps the ledger in integers
    return Math.ceil(amount);
  }

  private async resolveBalance(req: SpendRequest): Promise<number | null> {
    let balance: number | null = null;
    if (req.balanceCents !== undefined) {
      balance = req.balanceCents;
    } else if (this.balanceProvider) {
      try {
        balance = await this.balanceProvider(req.kind);
      } catch (err: any) {
        logger.warn(`Balance lookup failed for ${req.kind}: ${err?.message ?? String(err)}`);
        balance = null;
      }
    }
    if (typeof balance !== "number" || !Number.isFinite(balance)) return null;
    this.lastBalances.set(req.kind, { cents: balance, at: Date.now() });
    return balance;
  }

  private reserveFor(kind: SpendKind): number {
    return kind === "topup" ? this.policy.minimumUsdcReserveCents : this.policy.minimumReserveCents;
  }

  private sumRows(
    kinds: SpendKind[],
    window: "hour" | "day",
  ): { total: number; count: number } {
    const col = window === "hour" ? "window_hour" : "window_day";
    const value = window === "hour" ? hourWindow() : dayWindow();
    const names = kinds.map((k) => GUARD_TOOL_PREFIX + k);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS count FROM spend_tracking
         WHERE tool_name IN (${names.map(() => "?").join(",")}) AND ${col} = ?`,
      )
      .get(...names, value) as { total: number; count: number };
    return row;
  }

  private categorySum(category: SpendCategory, window: "hour" | "day"): number {
    const col = window === "hour" ? "window_hour" : "window_day";
    const value = window === "hour" ? hourWindow() : dayWindow();
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_tracking WHERE category = ? AND ${col} = ?`)
      .get(category, value) as { total: number };
    return row.total;
  }

  private evaluate(
    kind: SpendKind,
    amount: number,
    balance: number | null,
    opts: { balanceOptional?: boolean } = {},
  ): { code: string; reason: string } | null {
    const limits = limitsForKind(this.policy, kind);
    const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

    if (amount > limits.single) {
      return {
        code: "SINGLE_CAP_EXCEEDED",
        reason: `${kind} of ${amount}c (${dollars(amount)}) exceeds single cap ${limits.single}c`,
      };
    }

    // Per-kind (or per-group for child funding) hourly / daily caps
    const group: SpendKind[] = CHILD_FUNDING_KINDS.includes(kind) ? CHILD_FUNDING_KINDS : [kind];
    const hourly = kind === "transfer" ? this.categorySum("transfer", "hour") : this.sumRows(group, "hour").total;
    const daily = kind === "transfer" ? this.categorySum("transfer", "day") : this.sumRows(group, "day").total;
    if (hourly + amount > limits.hourly) {
      return {
        code: "HOURLY_CAP_EXCEEDED",
        reason: `${kind} hourly cap exceeded: ${hourly} + ${amount} > ${limits.hourly}c`,
      };
    }
    if (daily + amount > limits.daily) {
      return {
        code: "DAILY_CAP_EXCEEDED",
        reason: `${kind} daily cap exceeded: ${daily} + ${amount} > ${limits.daily}c`,
      };
    }

    // All credit outflows share the transfer caps
    if (CREDIT_OUTFLOW_KINDS.includes(kind)) {
      const outHour = this.categorySum("transfer", "hour");
      const outDay = this.categorySum("transfer", "day");
      if (outHour + amount > this.policy.maxHourlyTransferCents) {
        return {
          code: "HOURLY_CAP_EXCEEDED",
          reason: `credit outflow hourly cap exceeded: ${outHour} + ${amount} > ${this.policy.maxHourlyTransferCents}c`,
        };
      }
      if (outDay + amount > this.policy.maxDailyTransferCents) {
        return {
          code: "DAILY_CAP_EXCEEDED",
          reason: `credit outflow daily cap exceeded: ${outDay} + ${amount} > ${this.policy.maxDailyTransferCents}c`,
        };
      }
      if (this.countTransfersThisTurn() >= this.policy.maxTransfersPerTurn) {
        return {
          code: "TURN_TRANSFER_LIMIT",
          reason: `maximum ${this.policy.maxTransfersPerTurn} credit transfers per turn reached`,
        };
      }
    }

    if (BALANCE_REQUIRED_KINDS.has(kind)) {
      if (balance === null) {
        if (!opts.balanceOptional) {
          return {
            code: "BALANCE_UNKNOWN",
            reason: `${kind} denied: balance unknown, cannot verify the ${this.reserveFor(kind)}c reserve`,
          };
        }
      } else if (balance - amount < this.reserveFor(kind)) {
        return {
          code: "RESERVE_VIOLATION",
          reason: `${kind} of ${amount}c would leave ${balance - amount}c, below the ${this.reserveFor(kind)}c minimum reserve`,
        };
      }
    }

    return null;
  }

  private reserve(req: SpendRequest, amount: number): string {
    const ticket = ulid();
    this.db
      .prepare(
        `INSERT INTO spend_tracking (id, tool_name, amount_cents, recipient, domain, category, window_hour, window_day)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        ticket,
        GUARD_TOOL_PREFIX + req.kind,
        amount,
        req.recipient ?? null,
        KIND_CATEGORY[req.kind],
        hourWindow(),
        dayWindow(),
      );
    return ticket;
  }

  private deny(req: SpendRequest, amount: number, code: string, reason: string): SpendAuthorization {
    logger.warn(`Spend denied [${req.kind}] ${amount}c: ${reason}`);
    try {
      this.audit(req, "denied", amount, undefined, `${code}: ${reason}`);
    } catch (err: any) {
      logger.error("Failed to write spend denial audit", err instanceof Error ? err : undefined);
    }
    return { ok: false, code, reason };
  }

  private audit(
    req: SpendRequest,
    outcome: "authorized" | "denied" | "settled" | "released",
    amount: number,
    ticket?: string,
    detail?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO spend_audit (id, ticket, kind, outcome, amount_cents, recipient, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ulid(), ticket ?? null, req.kind, outcome, amount, req.recipient ?? null, req.reason, detail ?? null);
  }
}

// ─── Process-wide guard ─────────────────────────────────────────

let activeGuard: SpendGuard | null = null;

export function installSpendGuard(guard: SpendGuard | null): void {
  activeGuard = guard;
}

export function getSpendGuard(): SpendGuard | null {
  return activeGuard;
}

/** Authorize through the installed guard; denies when none is installed. */
export async function authorizeSpend(
  req: SpendRequest,
  guard: SpendGuard | null = activeGuard,
): Promise<SpendAuthorization> {
  if (!guard) {
    return {
      ok: false,
      code: "NO_GUARD",
      reason: `${req.kind} denied: spend guard is not initialised (fail closed)`,
    };
  }
  return guard.authorize(req);
}

export function settleSpend(
  auth: SpendAuthorization,
  actualCents?: number,
  guard: SpendGuard | null = activeGuard,
  detail?: string,
): void {
  if (!auth.ok || !guard) return;
  try {
    guard.settle(auth.ticket, actualCents, detail);
  } catch (err: any) {
    logger.error("Failed to settle spend", err instanceof Error ? err : undefined);
  }
}

export function releaseSpend(
  auth: SpendAuthorization,
  why: string,
  guard: SpendGuard | null = activeGuard,
): void {
  if (!auth.ok || !guard) return;
  try {
    guard.release(auth.ticket, why);
  } catch (err: any) {
    logger.error("Failed to release spend", err instanceof Error ? err : undefined);
  }
}

/** True when the URL's host is (a subdomain of) an allowlisted domain. Empty list = deny all. */
export function isX402DomainAllowed(url: string, allowedDomains: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

/**
 * Gas cost in cents, rounded up. With a configured ETH price the figure is padded by 50%
 * (gas price moves between estimate and inclusion); without one the fixed estimate is used.
 */
export function estimateGasCents(estimatedWei: bigint, policy: TreasuryPolicy): number {
  if (policy.ethPriceCents > 0) {
    const eth = Number(estimatedWei) / 1e18;
    return Math.max(1, Math.ceil(eth * policy.ethPriceCents * 1.5));
  }
  return Math.max(1, Math.ceil(policy.gasCostEstimateCents));
}
