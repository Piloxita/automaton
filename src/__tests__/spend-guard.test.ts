/**
 * SpendGuard tests: caps, reserve, unknown balance, x402 amount parsing,
 * and that every money-moving path calls the guard (network clients mocked).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  SpendGuard,
  installSpendGuard,
  authorizeSpend,
  estimateGasCents,
  isX402DomainAllowed,
  normalizeTreasuryPolicy,
} from "../survival/spend-guard.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import type { TreasuryPolicy } from "../types.js";

// ─── Network mocks (no real HTTP / RPC) ─────────────────────────

const httpRequest = vi.fn();
vi.mock("../conway/http-client.js", () => ({
  ResilientHttpClient: class {
    request = (...a: unknown[]) => httpRequest(...a);
  },
  CircuitOpenError: class extends Error {},
}));

const viemClients = vi.hoisted(() => ({
  writeContract: vi.fn(),
  estimateGas: vi.fn(),
  getGasPrice: vi.fn(),
  getBalance: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      estimateGas: viemClients.estimateGas,
      getGasPrice: viemClients.getGasPrice,
      getBalance: viemClients.getBalance,
      waitForTransactionReceipt: viemClients.waitForTransactionReceipt,
    }),
    createWalletClient: () => ({ writeContract: viemClients.writeContract }),
  };
});

import {
  x402Fetch,
  parseMaxAmountRequired,
  atomicToCents,
} from "../conway/x402.js";
import { topupCredits } from "../conway/topup.js";
import { SimpleFundingProtocol } from "../orchestration/simple-tracker.js";
import { registerAgent } from "../registry/erc8004.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createFinancialRules } from "../agent/policy-rules/financial.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import {
  createTestDb,
  createTestIdentity,
  createTestConfig,
  MockConwayClient,
  MockInferenceClient,
} from "./mocks.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE turns (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  return db;
}

function policy(over: Partial<TreasuryPolicy> = {}): TreasuryPolicy {
  return { ...DEFAULT_TREASURY_POLICY, ...over };
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

function fakeAccount() {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    signTypedData: vi.fn().mockResolvedValue("0xsig"),
  } as any;
}

function response402(maxAmountRequired: string, extra: Record<string, unknown> = {}, version = 1) {
  return new Response(
    JSON.stringify({
      x402Version: version,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired,
          payTo: PAY_TO,
          asset: BASE_USDC,
          ...extra,
        },
      ],
    }),
    { status: 402, headers: { "Content-Type": "application/json" } },
  );
}

function ok200() {
  return new Response(JSON.stringify({ ok: true, credits_cents: 500 }), { status: 200 });
}

function auditRows(db: Database.Database, outcome?: string) {
  const sql = outcome
    ? "SELECT * FROM spend_audit WHERE outcome = ? ORDER BY rowid"
    : "SELECT * FROM spend_audit ORDER BY rowid";
  return (outcome ? db.prepare(sql).all(outcome) : db.prepare(sql).all()) as any[];
}

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
  httpRequest.mockReset();
  Object.values(viemClients).forEach((m) => m.mockReset());
});

afterEach(() => {
  installSpendGuard(null);
  db.close();
});

// ─── Core guard behaviour ───────────────────────────────────────

describe("SpendGuard core", () => {
  it("authorizes within limits and records the reservation + audit row", async () => {
    const guard = new SpendGuard(db, policy());
    const auth = await guard.authorize({
      kind: "transfer", amountCents: 500, recipient: "0xabc", reason: "t", balanceCents: 100_000,
    });
    expect(auth.ok).toBe(true);
    expect(guard.getSpend("transfer", "hour")).toBe(500);
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transfer", outcome: "authorized", amount_cents: 500, recipient: "0xabc" });
  });

  it("denies above the per-kind single cap and audits the denial", async () => {
    const guard = new SpendGuard(db, policy({ maxSingleTransferCents: 1000 }));
    const auth = await guard.authorize({
      kind: "transfer", amountCents: 1001, recipient: "0xabc", reason: "big", balanceCents: 1_000_000,
    });
    expect(auth).toMatchObject({ ok: false, code: "SINGLE_CAP_EXCEEDED" });
    const denied = auditRows(db, "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ kind: "transfer", amount_cents: 1001, recipient: "0xabc", reason: "big" });
    expect(guard.getSpend("transfer", "hour")).toBe(0);
  });

  it.each([
    ["x402", { maxX402PaymentCents: 100, maxX402HourlyCents: 150, maxX402DailyCents: 5000 }],
    ["topup", { maxTopupSingleCents: 500, maxTopupHourlyCents: 800, maxTopupDailyCents: 10000 }],
    ["fund_child", { maxChildFundingSingleCents: 500, maxChildFundingHourlyCents: 800, maxChildFundingDailyCents: 10000 }],
    ["gas", { maxGasSingleCents: 50, maxGasHourlyCents: 80, maxGasDailyCents: 1000 }],
  ] as const)("enforces the hourly cap for %s", async (kind, over) => {
    const guard = new SpendGuard(db, policy({ ...over, minimumReserveCents: 0, minimumUsdcReserveCents: 0, maxTransfersPerTurn: 99 }));
    const one = kind === "x402" ? 100 : kind === "gas" ? 50 : 500;
    expect((await guard.authorize({ kind, amountCents: one, reason: "a", balanceCents: 1e9 })).ok).toBe(true);
    const second = await guard.authorize({ kind, amountCents: one, reason: "b", balanceCents: 1e9 });
    expect(second).toMatchObject({ ok: false, code: "HOURLY_CAP_EXCEEDED" });
  });

  it.each([
    ["x402", { maxX402PaymentCents: 100, maxX402HourlyCents: 1000, maxX402DailyCents: 150 }],
    ["topup", { maxTopupSingleCents: 500, maxTopupHourlyCents: 5000, maxTopupDailyCents: 800 }],
    ["gas", { maxGasSingleCents: 50, maxGasHourlyCents: 500, maxGasDailyCents: 80 }],
  ] as const)("enforces the daily cap for %s", async (kind, over) => {
    const guard = new SpendGuard(db, policy({ ...over, minimumReserveCents: 0, minimumUsdcReserveCents: 0 }));
    const one = kind === "x402" ? 100 : kind === "gas" ? 50 : 500;
    expect((await guard.authorize({ kind, amountCents: one, reason: "a", balanceCents: 1e9 })).ok).toBe(true);
    expect(await guard.authorize({ kind, amountCents: one, reason: "b", balanceCents: 1e9 }))
      .toMatchObject({ ok: false, code: "DAILY_CAP_EXCEEDED" });
  });

  it("child funding kinds share one cap, and also count against the transfer caps", async () => {
    const guard = new SpendGuard(db, policy({
      maxChildFundingSingleCents: 2000, maxChildFundingHourlyCents: 3000, maxChildFundingDailyCents: 3000,
      maxSingleTransferCents: 5000, maxHourlyTransferCents: 100_000, maxDailyTransferCents: 100_000,
      maxTransfersPerTurn: 99, minimumReserveCents: 0,
    }));
    expect((await guard.authorize({ kind: "fund_child", amountCents: 2000, reason: "a", balanceCents: 1e9 })).ok).toBe(true);
    expect(await guard.authorize({ kind: "orchestrator_fund", amountCents: 2000, reason: "b", balanceCents: 1e9 }))
      .toMatchObject({ ok: false, code: "HOURLY_CAP_EXCEEDED" });
  });

  it("child funding cannot bypass the overall transfer hourly cap", async () => {
    const guard = new SpendGuard(db, policy({
      maxSingleTransferCents: 5000, maxHourlyTransferCents: 3000, maxDailyTransferCents: 100_000,
      maxChildFundingSingleCents: 2000, maxChildFundingHourlyCents: 100_000, maxChildFundingDailyCents: 100_000,
      maxTransfersPerTurn: 99, minimumReserveCents: 0,
    }));
    expect((await guard.authorize({ kind: "transfer", amountCents: 2000, reason: "a", balanceCents: 1e9 })).ok).toBe(true);
    expect(await guard.authorize({ kind: "fund_child", amountCents: 2000, reason: "b", balanceCents: 1e9 }))
      .toMatchObject({ ok: false, code: "HOURLY_CAP_EXCEEDED" });
  });

  it("denies when balance after spend would fall below the minimum reserve", async () => {
    const guard = new SpendGuard(db, policy({ minimumReserveCents: 1000 }));
    const auth = await guard.authorize({ kind: "transfer", amountCents: 600, reason: "r", balanceCents: 1500 });
    expect(auth).toMatchObject({ ok: false, code: "RESERVE_VIOLATION" });
    expect((await guard.authorize({ kind: "transfer", amountCents: 500, reason: "r", balanceCents: 1500 })).ok).toBe(true);
  });

  it("uses minimumUsdcReserveCents for topups", async () => {
    const guard = new SpendGuard(db, policy({ minimumUsdcReserveCents: 300 }));
    expect(await guard.authorize({ kind: "topup", amountCents: 500, reason: "r", balanceCents: 700 }))
      .toMatchObject({ ok: false, code: "RESERVE_VIOLATION" });
    expect((await guard.authorize({ kind: "topup", amountCents: 500, reason: "r", balanceCents: 800 })).ok).toBe(true);
  });

  it.each(["x402", "topup", "transfer", "fund_child", "orchestrator_fund"] as const)(
    "denies %s when the balance is unknown (no provider)",
    async (kind) => {
      const guard = new SpendGuard(db, policy());
      const auth = await guard.authorize({ kind, amountCents: 100, reason: "r" });
      expect(auth).toMatchObject({ ok: false, code: "BALANCE_UNKNOWN" });
    },
  );

  it("denies when the balance provider throws or returns null", async () => {
    const throwing = new SpendGuard(db, policy(), async () => { throw new Error("rpc down"); });
    expect(await throwing.authorize({ kind: "x402", amountCents: 10, reason: "r" })).toMatchObject({ ok: false, code: "BALANCE_UNKNOWN" });
    const nulling = new SpendGuard(db, policy(), async () => null);
    expect(await nulling.authorize({ kind: "topup", amountCents: 500, reason: "r" })).toMatchObject({ ok: false, code: "BALANCE_UNKNOWN" });
  });

  it("reads the balance from the provider when none is supplied", async () => {
    const provider = vi.fn().mockResolvedValue(100_000);
    const guard = new SpendGuard(db, policy(), provider);
    expect((await guard.authorize({ kind: "x402", amountCents: 50, reason: "r" })).ok).toBe(true);
    expect(provider).toHaveBeenCalledWith("x402");
  });

  it("does not require a known balance for gas (the preflight checks ETH)", async () => {
    const guard = new SpendGuard(db, policy());
    expect((await guard.authorize({ kind: "gas", amountCents: 25, reason: "tx" })).ok).toBe(true);
  });

  it("caps credit outflows per turn", async () => {
    const guard = new SpendGuard(db, policy({ maxTransfersPerTurn: 2, minimumReserveCents: 0 }));
    expect((await guard.authorize({ kind: "transfer", amountCents: 10, reason: "1", balanceCents: 1e6 })).ok).toBe(true);
    expect((await guard.authorize({ kind: "fund_child", amountCents: 10, reason: "2", balanceCents: 1e6 })).ok).toBe(true);
    expect(await guard.authorize({ kind: "orchestrator_fund", amountCents: 10, reason: "3", balanceCents: 1e6 }))
      .toMatchObject({ ok: false, code: "TURN_TRANSFER_LIMIT" });
  });

  it.each([0, -5, NaN, Infinity, "10" as unknown as number])("rejects invalid amount %s", async (amt) => {
    const guard = new SpendGuard(db, policy());
    expect(await guard.authorize({ kind: "gas", amountCents: amt, reason: "r" })).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
  });

  it("rounds fractional cents up", async () => {
    const guard = new SpendGuard(db, policy());
    const auth = await guard.authorize({ kind: "gas", amountCents: 0.2, reason: "r" });
    expect(auth).toMatchObject({ ok: true, amountCents: 1 });
  });

  it("settle() records the real amount; release() frees the reservation", async () => {
    const guard = new SpendGuard(db, policy({ minimumReserveCents: 0 }));
    const a = await guard.authorize({ kind: "transfer", amountCents: 500, reason: "a", balanceCents: 1e6 });
    const b = await guard.authorize({ kind: "transfer", amountCents: 300, reason: "b", balanceCents: 1e6 });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    guard.settle(a.ticket, 450);
    guard.release(b.ticket, "api failed");
    expect(guard.getSpend("transfer", "hour")).toBe(450);
    expect(auditRows(db, "settled")[0]).toMatchObject({ amount_cents: 450 });
    expect(auditRows(db, "released")[0]).toMatchObject({ detail: "api failed" });
  });

  it("unsettled reservations keep counting (fail closed)", async () => {
    const guard = new SpendGuard(db, policy({ maxX402PaymentCents: 100, maxX402HourlyCents: 100, minimumReserveCents: 0 }));
    expect((await guard.authorize({ kind: "x402", amountCents: 100, reason: "a", balanceCents: 1e6 })).ok).toBe(true);
    expect((await guard.authorize({ kind: "x402", amountCents: 1, reason: "b", balanceCents: 1e6 })).ok).toBe(false);
  });

  it("persists spend across guard instances (SQLite)", async () => {
    const g1 = new SpendGuard(db, policy({ maxX402PaymentCents: 100, maxX402HourlyCents: 100, minimumReserveCents: 0 }));
    await g1.authorize({ kind: "x402", amountCents: 100, reason: "a", balanceCents: 1e6 });
    const g2 = new SpendGuard(db, policy({ maxX402PaymentCents: 100, maxX402HourlyCents: 100, minimumReserveCents: 0 }));
    expect((await g2.authorize({ kind: "x402", amountCents: 1, reason: "b", balanceCents: 1e6 })).ok).toBe(false);
  });

  it("falls back to defaults for invalid policy numbers", () => {
    const p = normalizeTreasuryPolicy({ maxTopupDailyCents: NaN, maxGasSingleCents: -1 } as any);
    expect(p.maxTopupDailyCents).toBe(DEFAULT_TREASURY_POLICY.maxTopupDailyCents);
    expect(p.maxGasSingleCents).toBe(DEFAULT_TREASURY_POLICY.maxGasSingleCents);
  });

  it("authorizeSpend() fails closed when no guard is installed", async () => {
    installSpendGuard(null);
    expect(await authorizeSpend({ kind: "gas", amountCents: 1, reason: "r" })).toMatchObject({ ok: false, code: "NO_GUARD" });
  });

  it("estimateGasCents uses the fixed estimate without an ETH price, a padded figure with one", () => {
    expect(estimateGasCents(10n ** 15n, policy({ ethPriceCents: 0, gasCostEstimateCents: 25 }))).toBe(25);
    // 0.001 ETH * 300000c * 1.5 = 450c
    expect(estimateGasCents(10n ** 15n, policy({ ethPriceCents: 300_000 }))).toBe(450);
  });

  it("isX402DomainAllowed: exact + subdomain match, empty list denies all", () => {
    expect(isX402DomainAllowed("https://conway.tech/x", ["conway.tech"])).toBe(true);
    expect(isX402DomainAllowed("https://api.conway.tech/x", ["conway.tech"])).toBe(true);
    expect(isX402DomainAllowed("https://evilconway.tech/x", ["conway.tech"])).toBe(false);
    expect(isX402DomainAllowed("https://conway.tech/x", [])).toBe(false);
    expect(isX402DomainAllowed("not a url", ["conway.tech"])).toBe(false);
    expect(isX402DomainAllowed("https://any.example.com/x", ["*"])).toBe(true);
    expect(isX402DomainAllowed("not a url", ["*"])).toBe(false);
  });
});

// ─── x402 amount parsing ────────────────────────────────────────

describe("x402 amount parsing (base units, 6 decimals)", () => {
  it.each([
    ["1", 1n],
    ["1000", 1000n],
    ["100000", 100_000n], // v1 used to read this as 100000 USDC
    ["1000000", 1_000_000n],
    ["999999", 999_999n],
    ["10000000", 10_000_000n],
  ])("integer %s is base units for v1 and v2", (input, expected) => {
    expect(parseMaxAmountRequired(input, 1)).toBe(expected);
    expect(parseMaxAmountRequired(input, 2)).toBe(expected);
  });

  it("strings with a decimal point are whole USDC", () => {
    expect(parseMaxAmountRequired("0.5", 1)).toBe(500_000n);
    expect(parseMaxAmountRequired("1.25", 2)).toBe(1_250_000n);
  });

  it("rejects garbage", () => {
    expect(() => parseMaxAmountRequired("abc", 1)).toThrow();
    expect(() => parseMaxAmountRequired("-5", 1)).toThrow();
  });

  it("atomicToCents rounds up", () => {
    expect(atomicToCents(10_000n)).toBe(1);
    expect(atomicToCents(10_001n)).toBe(2);
    expect(atomicToCents(1n)).toBe(1);
    expect(atomicToCents(1_000_000n)).toBe(100);
  });
});

// ─── x402Fetch wiring ───────────────────────────────────────────

describe("x402Fetch calls the SpendGuard", () => {
  it("records the REAL amount parsed from a v1 integer 402 response", async () => {
    const guard = new SpendGuard(db, policy({ minimumReserveCents: 0 }), async () => 100_000);
    installSpendGuard(guard);
    httpRequest.mockResolvedValueOnce(response402("50000")).mockResolvedValueOnce(ok200()); // 0.05 USDC = 5c

    const r = await x402Fetch("https://conway.tech/api", fakeAccount(), "GET", undefined, undefined, 100);
    expect(r.success).toBe(true);
    expect(r.amountCents).toBe(5);
    expect(guard.getSpend("x402", "hour")).toBe(5);
    const settled = auditRows(db, "settled");
    expect(settled[0]).toMatchObject({ kind: "x402", amount_cents: 5, recipient: PAY_TO });
  });

  it("v1 integer '100000' (0.1 USDC) is no longer treated as 100000 USDC", async () => {
    const guard = new SpendGuard(db, policy({ minimumReserveCents: 0 }), async () => 100_000);
    installSpendGuard(guard);
    httpRequest.mockResolvedValueOnce(response402("100000")).mockResolvedValueOnce(ok200());
    const acct = fakeAccount();
    const r = await x402Fetch("https://conway.tech/api", acct, "GET", undefined, undefined, 100);
    expect(r.amountCents).toBe(10);
    const typed = acct.signTypedData.mock.calls[0][0];
    expect(typed.message.value).toBe(100_000n);
  });

  it("denies (and never signs) when the amount exceeds the policy cap", async () => {
    const guard = new SpendGuard(db, policy({ maxX402PaymentCents: 100, minimumReserveCents: 0 }), async () => 1e6);
    installSpendGuard(guard);
    httpRequest.mockResolvedValueOnce(response402("5000000")); // 5 USDC = 500c
    const acct = fakeAccount();
    const r = await x402Fetch("https://conway.tech/api", acct, "GET");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Spend denied/);
    expect(acct.signTypedData).not.toHaveBeenCalled();
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(auditRows(db, "denied")[0]).toMatchObject({ kind: "x402", amount_cents: 500 });
  });

  it("denies when no guard is installed (fail closed)", async () => {
    installSpendGuard(null);
    httpRequest.mockResolvedValueOnce(response402("10000"));
    const acct = fakeAccount();
    const r = await x402Fetch("https://conway.tech/api", acct, "GET");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not initialised/);
    expect(acct.signTypedData).not.toHaveBeenCalled();
  });

  it("denies when the balance cannot be read", async () => {
    installSpendGuard(new SpendGuard(db, policy(), async () => null));
    httpRequest.mockResolvedValueOnce(response402("10000"));
    const acct = fakeAccount();
    const r = await x402Fetch("https://conway.tech/api", acct, "GET");
    expect(r.error).toMatch(/balance unknown/);
    expect(acct.signTypedData).not.toHaveBeenCalled();
  });

  it("refuses an asset that is not USDC", async () => {
    installSpendGuard(new SpendGuard(db, policy({ minimumReserveCents: 0 }), async () => 1e6));
    httpRequest.mockResolvedValueOnce(response402("10000", { asset: "0x1111111111111111111111111111111111111111" }));
    const acct = fakeAccount();
    const r = await x402Fetch("https://conway.tech/api", acct, "GET");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not USDC/);
    expect(acct.signTypedData).not.toHaveBeenCalled();
  });

  it("releases the reservation when signing fails", async () => {
    const guard = new SpendGuard(db, policy({ minimumReserveCents: 0 }), async () => 1e6);
    installSpendGuard(guard);
    httpRequest.mockResolvedValueOnce(response402("50000"));
    const acct = fakeAccount();
    acct.signTypedData.mockRejectedValue(new Error("boom"));
    const r = await x402Fetch("https://conway.tech/api", acct, "GET");
    expect(r.success).toBe(false);
    expect(guard.getSpend("x402", "hour")).toBe(0);
  });

  it("hourly cap trips across repeated paid calls", async () => {
    const guard = new SpendGuard(db, policy({ maxX402HourlyCents: 10, minimumReserveCents: 0 }), async () => 1e6);
    installSpendGuard(guard);
    const results = [];
    for (let i = 0; i < 3; i++) {
      httpRequest.mockResolvedValueOnce(response402("50000")).mockResolvedValueOnce(ok200()); // 5c each
      results.push(await x402Fetch("https://conway.tech/api", fakeAccount(), "GET"));
    }
    expect(results.map((r) => r.success)).toEqual([true, true, false]);
  });

  it("passes a request with no 402 straight through without touching the guard", async () => {
    installSpendGuard(null);
    httpRequest.mockResolvedValueOnce(ok200());
    const r = await x402Fetch("https://conway.tech/free", fakeAccount(), "GET");
    expect(r.success).toBe(true);
  });
});

// ─── topup wiring ───────────────────────────────────────────────

describe("topupCredits calls the SpendGuard (kind 'topup')", () => {
  it("authorizes the real 402 amount as a topup and records it", async () => {
    const guard = new SpendGuard(db, policy({ minimumUsdcReserveCents: 0 }), async () => 100_000);
    installSpendGuard(guard);
    httpRequest.mockResolvedValueOnce(response402("5000000")).mockResolvedValueOnce(ok200()); // $5
    const r = await topupCredits("https://api.conway.tech", fakeAccount(), 5);
    expect(r.success).toBe(true);
    expect(guard.getSpend("topup", "day")).toBe(500);
    expect(auditRows(db, "authorized")[0]).toMatchObject({ kind: "topup", amount_cents: 500 });
  });

  it("does not pay when the daily topup cap is reached", async () => {
    const guard = new SpendGuard(db, policy({ maxTopupDailyCents: 500, minimumUsdcReserveCents: 0 }), async () => 1e6);
    installSpendGuard(guard);
    httpRequest.mockResolvedValueOnce(response402("5000000")).mockResolvedValueOnce(ok200());
    expect((await topupCredits("https://api.conway.tech", fakeAccount(), 5)).success).toBe(true);
    httpRequest.mockResolvedValueOnce(response402("5000000"));
    const second = await topupCredits("https://api.conway.tech", fakeAccount(), 5);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/daily cap/);
    expect(httpRequest).toHaveBeenCalledTimes(3);
  });

  it("refuses a server that charges more than the tier", async () => {
    installSpendGuard(new SpendGuard(db, policy({ minimumUsdcReserveCents: 0 }), async () => 1e6));
    httpRequest.mockResolvedValueOnce(response402("25000000")); // $25 for a $5 tier
    const acct = fakeAccount();
    const r = await topupCredits("https://api.conway.tech", acct, 5);
    expect(r.success).toBe(false);
    expect(acct.signTypedData).not.toHaveBeenCalled();
  });

  it("denies a topup when no guard is installed", async () => {
    installSpendGuard(null);
    httpRequest.mockResolvedValueOnce(response402("5000000"));
    const r = await topupCredits("https://api.conway.tech", fakeAccount(), 5);
    expect(r.success).toBe(false);
  });

  it("rejects an amount that is not a valid tier before any network call", async () => {
    installSpendGuard(new SpendGuard(db, policy(), async () => 1e6));
    const r = await topupCredits("https://api.conway.tech", fakeAccount(), 123);
    expect(r.success).toBe(false);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});

// ─── tools: topup_credits / transfer_credits / fund_child / x402_fetch ──

describe("agent tools call the SpendGuard", () => {
  let tdb: ReturnType<typeof createTestDb>;
  let ctx: any;
  const tools = createBuiltinTools("test-sandbox-id");
  const tool = (n: string) => tools.find((t) => t.name === n)!;

  beforeEach(() => {
    tdb = createTestDb();
    ctx = {
      identity: { ...createTestIdentity(), account: fakeAccount() },
      config: createTestConfig(),
      db: tdb,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
  });
  afterEach(() => tdb.close());

  it("transfer_credits is blocked by the guard's single cap and audited", async () => {
    installSpendGuard(new SpendGuard(tdb.raw, policy({ maxSingleTransferCents: 100, minimumReserveCents: 0 })));
    const out = await tool("transfer_credits").execute({ to_address: "0xrecipient", amount_cents: 4000 }, ctx);
    expect(out).toMatch(/^Blocked: .*single cap/);
    expect(tdb.raw.prepare("SELECT COUNT(*) AS n FROM spend_audit WHERE outcome='denied' AND kind='transfer'").get()).toEqual({ n: 1 });
  });

  it("transfer_credits is blocked when no guard is installed", async () => {
    installSpendGuard(null);
    const out = await tool("transfer_credits").execute({ to_address: "0xrecipient", amount_cents: 100 }, ctx);
    expect(out).toMatch(/^Blocked: .*not initialised/);
  });

  it("transfer_credits repeated calls are stopped by the hourly cap", async () => {
    installSpendGuard(new SpendGuard(tdb.raw, policy({
      maxHourlyTransferCents: 5000, maxSingleTransferCents: 5000, minimumReserveCents: 0, maxTransfersPerTurn: 99,
    })));
    const first = await tool("transfer_credits").execute({ to_address: "0xrecipient", amount_cents: 3000 }, ctx);
    expect(first).toContain("transfer submitted");
    const second = await tool("transfer_credits").execute({ to_address: "0xrecipient", amount_cents: 3000 }, ctx);
    expect(second).toMatch(/^Blocked: .*hourly cap/);
  });

  it("transfer_credits respects the reserve using the real balance", async () => {
    installSpendGuard(new SpendGuard(tdb.raw, policy({ minimumReserveCents: 9000 })));
    const out = await tool("transfer_credits").execute({ to_address: "0xrecipient", amount_cents: 4000 }, ctx);
    expect(out).toMatch(/^Blocked: .*minimum reserve/);
  });

  function addChild() {
    tdb.insertChild({
      id: "child-1", name: "kid", address: "0x1111111111111111111111111111111111111111",
      sandboxId: "sb-1", genesisPrompt: "x", creatorMessage: "", fundedAmountCents: 0,
      status: "healthy", createdAt: new Date().toISOString(),
    } as any);
  }

  it("fund_child goes through the guard and is capped by the child-funding limits", async () => {
    addChild();
    installSpendGuard(new SpendGuard(tdb.raw, policy({
      maxChildFundingSingleCents: 1000, maxChildFundingHourlyCents: 1500, maxChildFundingDailyCents: 1500,
      minimumReserveCents: 0, maxTransfersPerTurn: 99,
    })));
    expect(await tool("fund_child").execute({ child_id: "child-1", amount_cents: 1000 }, ctx)).not.toMatch(/^Blocked/);
    const second = await tool("fund_child").execute({ child_id: "child-1", amount_cents: 1000 }, ctx);
    expect(second).toMatch(/^Blocked: .*cap/);
    const single = await tool("fund_child").execute({ child_id: "child-1", amount_cents: 1001 }, ctx);
    expect(single).toMatch(/^Blocked: .*single cap/);
  });

  it("fund_child is blocked when no guard is installed", async () => {
    addChild();
    installSpendGuard(null);
    expect(await tool("fund_child").execute({ child_id: "child-1", amount_cents: 100 }, ctx)).toMatch(/^Blocked: .*not initialised/);
  });

  it("topup_credits reaches the guard (denied under a zero topup cap, nothing is signed)", async () => {
    const guard = new SpendGuard(tdb.raw, policy({ maxTopupSingleCents: 0 }), async () => 1e6);
    installSpendGuard(guard);
    // balance lookup inside the tool uses getUsdcBalance (RPC): stub the x402 module's call via http mock
    vi.spyOn(await import("../conway/x402.js"), "getUsdcBalance").mockResolvedValue(1000);
    httpRequest.mockResolvedValueOnce(response402("5000000"));
    const out = await tool("topup_credits").execute({ amount_usd: 5 }, ctx);
    expect(out).toMatch(/Credit topup failed: .*single cap/);
    expect(ctx.identity.account.signTypedData).not.toHaveBeenCalled();
  });

  it("x402_fetch enforces the domain allowlist in the tool itself", async () => {
    installSpendGuard(new SpendGuard(tdb.raw, policy(), async () => 1e6));
    const out = await tool("x402_fetch").execute({ url: "https://evil.example/pay" }, ctx);
    expect(out).toMatch(/^Blocked: x402 payments are only allowed/);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("x402_fetch records the real amount through the guard", async () => {
    const guard = new SpendGuard(tdb.raw, policy({ minimumReserveCents: 0 }), async () => 1e6);
    installSpendGuard(guard);
    httpRequest.mockResolvedValueOnce(response402("50000")).mockResolvedValueOnce(ok200());
    const out = await tool("x402_fetch").execute({ url: "https://conway.tech/api" }, ctx);
    expect(out).toContain("x402 fetch succeeded");
    expect(guard.getSpend("x402", "hour")).toBe(5);
  });
});

// ─── Orchestrator funding ───────────────────────────────────────

describe("SimpleFundingProtocol (orchestrator funding) calls the SpendGuard", () => {
  function setup(pol: Partial<TreasuryPolicy>, balance: number | null = 1e6) {
    db.exec(`CREATE TABLE children (address TEXT PRIMARY KEY, funded_amount_cents INTEGER NOT NULL DEFAULT 0);`);
    db.prepare("INSERT INTO children (address) VALUES ('0xchild')").run();
    const guard = new SpendGuard(db, policy({ minimumReserveCents: 0, maxTransfersPerTurn: 99, ...pol }), async () => balance);
    installSpendGuard(guard);
    const conway = { transferCredits: vi.fn().mockResolvedValue({ status: "ok" }) } as any;
    return { guard, conway, funding: new SimpleFundingProtocol(conway, { address: "0xparent" } as any, { raw: db } as any) };
  }

  it("funds within the caps and records the spend", async () => {
    const { guard, conway, funding } = setup({});
    const r = await funding.fundChild("0xchild", 500);
    expect(r.success).toBe(true);
    expect(conway.transferCredits).toHaveBeenCalledTimes(1);
    expect(guard.getSpend("orchestrator_fund", "day")).toBe(500);
  });

  it("refuses above the single cap without calling the API, and reports why", async () => {
    const { conway, funding } = setup({ maxChildFundingSingleCents: 100 });
    const r = await funding.fundChild("0xchild", 500);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/single cap/);
    expect(conway.transferCredits).not.toHaveBeenCalled();
    expect(auditRows(db, "denied")[0]).toMatchObject({ kind: "orchestrator_fund", recipient: "0xchild" });
  });

  it("repeated funding hits the daily cap", async () => {
    const { funding } = setup({ maxChildFundingDailyCents: 1000, maxChildFundingHourlyCents: 1000 });
    expect((await funding.fundChild("0xchild", 600)).success).toBe(true);
    expect((await funding.fundChild("0xchild", 600)).success).toBe(false);
  });

  it("releases the reservation when the API call throws", async () => {
    const { guard, conway, funding } = setup({});
    conway.transferCredits.mockRejectedValue(new Error("net"));
    expect((await funding.fundChild("0xchild", 500)).success).toBe(false);
    expect(guard.getSpend("orchestrator_fund", "day")).toBe(0);
  });

  it("denies when the balance is unknown", async () => {
    const { conway, funding } = setup({}, null);
    expect((await funding.fundChild("0xchild", 500)).success).toBe(false);
    expect(conway.transferCredits).not.toHaveBeenCalled();
  });

  it("denies when no guard is installed", async () => {
    const { conway, funding } = setup({});
    installSpendGuard(null);
    expect((await funding.fundChild("0xchild", 500)).success).toBe(false);
    expect(conway.transferCredits).not.toHaveBeenCalled();
  });
});

// ─── ERC-8004 gas ───────────────────────────────────────────────

describe("ERC-8004 transactions call the SpendGuard (kind 'gas')", () => {
  const acct = { address: "0x1234567890abcdef1234567890abcdef12345678" } as any;
  const fakeDb = () => ({ raw: db, setRegistryEntry: vi.fn() }) as any;

  beforeEach(() => {
    db.exec(`CREATE TABLE onchain_transactions (
      id TEXT PRIMARY KEY, tx_hash TEXT, chain TEXT, operation TEXT, status TEXT,
      gas_used INTEGER, metadata TEXT, created_at TEXT DEFAULT (datetime('now')));`);
    viemClients.estimateGas.mockResolvedValue(100_000n);
    viemClients.getGasPrice.mockResolvedValue(1_000_000_000n);
    viemClients.getBalance.mockResolvedValue(10n ** 18n);
  });

  it("does not send the transaction when gas is denied", async () => {
    installSpendGuard(new SpendGuard(db, policy({ maxGasSingleCents: 0 })));
    await expect(registerAgent(acct, "https://x/agent.json", "mainnet", fakeDb())).rejects.toThrow(/denied/);
    expect(viemClients.writeContract).not.toHaveBeenCalled();
    expect(auditRows(db, "denied")[0]).toMatchObject({ kind: "gas" });
  });

  it("does not send the transaction when no guard is installed", async () => {
    installSpendGuard(null);
    await expect(registerAgent(acct, "https://x/agent.json", "mainnet", fakeDb())).rejects.toThrow(/not initialised/);
    expect(viemClients.writeContract).not.toHaveBeenCalled();
  });

  it("records gas spend when the tx is sent, and stops at the daily cap", async () => {
    const guard = new SpendGuard(db, policy({ gasCostEstimateCents: 25, maxGasDailyCents: 40, maxGasHourlyCents: 40 }));
    installSpendGuard(guard);
    viemClients.writeContract.mockResolvedValue("0xhash");
    viemClients.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [], gasUsed: 1n });
    await registerAgent(acct, "https://x/agent.json", "mainnet", fakeDb());
    expect(guard.getSpend("gas", "day")).toBe(25);
    await expect(registerAgent(acct, "https://x/agent.json", "mainnet", fakeDb())).rejects.toThrow(/cap/);
    expect(viemClients.writeContract).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation if the send throws", async () => {
    const guard = new SpendGuard(db, policy());
    installSpendGuard(guard);
    viemClients.writeContract.mockRejectedValue(new Error("rejected"));
    await expect(registerAgent(acct, "https://x/agent.json", "mainnet", fakeDb())).rejects.toThrow("rejected");
    expect(guard.getSpend("gas", "day")).toBe(0);
  });
});

// ─── Policy rules are real ──────────────────────────────────────

describe("financial policy rules use the guard", () => {
  function evalTool(name: string, args: Record<string, unknown>, riskLevel: any = "dangerous") {
    const policyDb = new Database(":memory:");
    policyDb.exec(`CREATE TABLE IF NOT EXISTS policy_decisions (
      id TEXT PRIMARY KEY, turn_id TEXT, tool_name TEXT, tool_args_hash TEXT, risk_level TEXT,
      decision TEXT, rules_evaluated TEXT, rules_triggered TEXT, reason TEXT, latency_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now')));`);
    const engine = new PolicyEngine(policyDb, createFinancialRules(DEFAULT_TREASURY_POLICY));
    const request: any = {
      tool: { name, riskLevel, category: "financial", description: "", parameters: {}, execute: async () => "" },
      args,
      context: {},
      turnContext: {
        inputSource: "agent",
        sessionSpend: { getHourlySpend: () => 0, getDailySpend: () => 0, checkLimit: () => ({ allowed: true }), recordSpend: () => {} },
      },
    };
    const decision = engine.evaluate(request);
    policyDb.close();
    return decision;
  }

  it("x402_max_single denies when x402 is disabled by policy", () => {
    const rules = createFinancialRules(policy({ maxX402PaymentCents: 0 }));
    const rule = rules.find((r) => r.id === "financial.x402_max_single")!;
    const res = rule.evaluate({ tool: { name: "x402_fetch" }, args: {}, turnContext: {} } as any);
    expect(res).not.toBeNull();
    expect(res!.action).toBe("deny");
  });

  it("x402_max_single denies once the hourly envelope is exhausted", async () => {
    const guard = new SpendGuard(db, policy({ maxX402HourlyCents: 100, maxX402PaymentCents: 100, minimumReserveCents: 0 }));
    installSpendGuard(guard);
    await guard.authorize({ kind: "x402", amountCents: 100, reason: "x", balanceCents: 1e6 });
    const rule = createFinancialRules(policy({ maxX402HourlyCents: 100 })).find((r) => r.id === "financial.x402_max_single")!;
    const res = rule.evaluate({ tool: { name: "x402_fetch" }, args: {}, turnContext: {} } as any);
    expect(res?.action).toBe("deny");
  });

  it("minimum_reserve denies using the guard's last balance reading", async () => {
    const guard = new SpendGuard(db, policy({ minimumReserveCents: 1000 }));
    installSpendGuard(guard);
    await guard.authorize({ kind: "transfer", amountCents: 1, reason: "seed", balanceCents: 1500 });
    const rule = createFinancialRules(policy({ minimumReserveCents: 1000 })).find((r) => r.id === "financial.minimum_reserve")!;
    const bad = rule.evaluate({ tool: { name: "transfer_credits" }, args: { amount_cents: 600 }, turnContext: {} } as any);
    expect(bad?.action).toBe("deny");
    const fine = rule.evaluate({ tool: { name: "transfer_credits" }, args: { amount_cents: 100 }, turnContext: {} } as any);
    expect(fine).toBeNull();
  });

  it("guard_caps denies fund_child above the child-funding single cap", () => {
    installSpendGuard(new SpendGuard(db, policy({ maxChildFundingSingleCents: 100 })));
    const decision = evalTool("fund_child", { child_id: "c", amount_cents: 500 });
    expect(decision.action).toBe("deny");
  });

  it("guard_caps denies topup_credits above the topup single cap", () => {
    installSpendGuard(new SpendGuard(db, policy({ maxTopupSingleCents: 1000 })));
    const decision = evalTool("topup_credits", { amount_usd: 25 }, "caution");
    expect(decision.action).toBe("deny");
  });

  it("inference_daily_cap applies to ordinary tools (not only non-existent 'chat'/'inference')", () => {
    const rules = createFinancialRules(DEFAULT_TREASURY_POLICY);
    const rule = rules.find((r) => r.id === "financial.inference_daily_cap")!;
    const mk = (name: string, riskLevel: string, spent: number) => ({
      tool: { name, riskLevel },
      args: {},
      turnContext: { sessionSpend: { getDailySpend: () => spent } },
    }) as any;
    expect(rule.evaluate(mk("exec", "caution", 60_000))?.action).toBe("deny");
    expect(rule.evaluate(mk("exec", "caution", 100))).toBeNull();
    expect(rule.evaluate(mk("check_credits", "safe", 60_000))).toBeNull();
  });
});

describe("SpendTracker inference category reads the real meter", () => {
  it("includes inference_costs rows", async () => {
    const { SpendTracker } = await import("../agent/spend-tracker.js");
    const tdb = createTestDb();
    tdb.raw
      .prepare(
        `INSERT INTO inference_costs (id, session_id, turn_id, model, provider, input_tokens, output_tokens, cost_cents, latency_ms, tier, task_type, cache_hit)
         VALUES ('i1','s','t','m','p',1,1,777,1,'t','agent_turn',0)`,
      )
      .run();
    const tracker = new SpendTracker(tdb.raw);
    expect(tracker.getDailySpend("inference")).toBeGreaterThanOrEqual(777);
    tdb.close();
  });
});
