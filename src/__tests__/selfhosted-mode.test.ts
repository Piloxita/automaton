/**
 * Self-hosted mode tests.
 *
 * Covers the additive "selfhosted" hostingMode switch: no Conway API key
 * required at startup, USDC-cents balance reporting (never a silent zero on
 * RPC failure), inference routed to an OpenAI-compatible backend (never
 * falling back to "conway"), configured models registered with prices and
 * selected by tier, Conway-only tools hidden, and expose_port/remove_port
 * via Cloudflare quick tunnels.
 *
 * No real network calls: x402/RPC and HTTP clients are mocked throughout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6 } from "../state/schema.js";

import {
  requiresConwayApiKey,
  shouldRegisterWithConway,
  shouldBootstrapTopup,
  shouldCreateSocialClient,
  shouldRefreshConwayModels,
  deriveSelfhostedModelStrategy,
} from "../hosting.js";

import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase, TickContext, HeartbeatLegacyContext } from "../types.js";

import { createBuiltinTools } from "../agent/tools.js";

import { ModelRegistry, configureSelfhostedModels } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";

import {
  openQuickTunnel,
  closeQuickTunnel,
  resetQuickTunnelsForTests,
  type SpawnFn,
} from "../conway/cloudflared-tunnel.js";

// ─── Network mocks (no real HTTP / RPC) ─────────────────────────

const httpRequest = vi.fn();
vi.mock("../conway/http-client.js", () => ({
  ResilientHttpClient: class {
    request = (...a: unknown[]) => httpRequest(...a);
  },
  CircuitOpenError: class extends Error {},
}));

const x402Mocks = vi.hoisted(() => ({
  getUsdcBalanceDetailed: vi.fn(),
  getUsdcBalance: vi.fn(),
}));
vi.mock("../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/x402.js")>();
  return {
    ...actual,
    getUsdcBalanceDetailed: x402Mocks.getUsdcBalanceDetailed,
    getUsdcBalance: x402Mocks.getUsdcBalance,
  };
});

// resolveInferenceBackend / createInferenceClient import AFTER the x402 mock
// is registered above (vi.mock is hoisted, so plain top-level import is fine).
import { resolveInferenceBackend, createInferenceClient } from "../conway/inference.js";
import { readSelfhostedBalanceCents, resetSelfhostedBalanceCacheForTests } from "../survival/selfhosted-balance.js";

beforeEach(() => {
  httpRequest.mockReset();
  x402Mocks.getUsdcBalanceDetailed.mockReset();
  x402Mocks.getUsdcBalance.mockReset();
  resetSelfhostedBalanceCacheForTests();
  resetQuickTunnelsForTests();
});

// ─── 1. Startup decision function ────────────────────────────────

describe("hosting mode decision helpers", () => {
  it("requiresConwayApiKey is false in selfhosted mode, true otherwise", () => {
    expect(requiresConwayApiKey({ hostingMode: "selfhosted" })).toBe(false);
    expect(requiresConwayApiKey({ hostingMode: "conway" })).toBe(true);
    expect(requiresConwayApiKey({})).toBe(true); // default = conway
  });

  it("skips Conway registration, bootstrap topup, model refresh, and the social relay in selfhosted mode", () => {
    expect(shouldRegisterWithConway({ hostingMode: "selfhosted" })).toBe(false);
    expect(shouldBootstrapTopup({ hostingMode: "selfhosted" })).toBe(false);
    expect(shouldRefreshConwayModels({ hostingMode: "selfhosted" })).toBe(false);
    expect(
      shouldCreateSocialClient({ hostingMode: "selfhosted", socialRelayUrl: "https://social.conway.tech" }),
    ).toBe(false);

    // Conway mode: unchanged behaviour.
    expect(shouldRegisterWithConway({ hostingMode: "conway" })).toBe(true);
    expect(shouldBootstrapTopup({ hostingMode: "conway" })).toBe(true);
    expect(shouldCreateSocialClient({ hostingMode: "conway", socialRelayUrl: "https://social.conway.tech" })).toBe(
      true,
    );
    expect(shouldCreateSocialClient({ hostingMode: "conway" })).toBe(false);
  });

  it("derives the model strategy from configured models, keyed by tier", () => {
    const models = [
      { id: "cheap-model", tier: "low_compute" as const, costPer1kInputCents: 0.1, costPer1kOutputCents: 0.2 },
      { id: "main-model", tier: "default" as const, costPer1kInputCents: 0.5, costPer1kOutputCents: 1.5 },
    ];
    const derived = deriveSelfhostedModelStrategy(models, DEFAULT_MODEL_STRATEGY_CONFIG);
    expect(derived.inferenceModel).toBe("main-model");
    expect(derived.lowComputeModel).toBe("cheap-model");
    // No "critical" tier configured — falls back to the low_compute model.
    expect(derived.criticalModel).toBe("cheap-model");
  });

  it("leaves the model strategy untouched when no models are configured", () => {
    expect(deriveSelfhostedModelStrategy(undefined, DEFAULT_MODEL_STRATEGY_CONFIG)).toBe(
      DEFAULT_MODEL_STRATEGY_CONFIG,
    );
    expect(deriveSelfhostedModelStrategy([], DEFAULT_MODEL_STRATEGY_CONFIG)).toBe(DEFAULT_MODEL_STRATEGY_CONFIG);
  });
});

// ─── 2. Balance provider: USDC cents, unknown on RPC failure ─────

describe("readSelfhostedBalanceCents", () => {
  const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

  it("returns USDC cents on a live read", async () => {
    x402Mocks.getUsdcBalanceDetailed.mockResolvedValueOnce({ balance: 12.345, network: "eip155:8453", ok: true });
    const reading = await readSelfhostedBalanceCents(ADDRESS);
    expect(reading.known).toBe(true);
    expect(reading.cents).toBe(1235); // 12.345 USDC -> rounds to 1235 cents
  });

  it("never reports zero on RPC failure — keeps the last known reading and flags it unknown", async () => {
    x402Mocks.getUsdcBalanceDetailed.mockResolvedValueOnce({ balance: 5, network: "eip155:8453", ok: true });
    const first = await readSelfhostedBalanceCents(ADDRESS);
    expect(first).toEqual({ cents: 500, known: true });

    x402Mocks.getUsdcBalanceDetailed.mockResolvedValueOnce({
      balance: 0,
      network: "eip155:8453",
      ok: false,
      error: "RPC timeout",
    });
    const second = await readSelfhostedBalanceCents(ADDRESS);
    expect(second.known).toBe(false);
    expect(second.cents).toBe(500); // last known value, NOT 0
  });

  it("reports 0 (not death-triggering by itself) with known:false when there has never been a successful read", async () => {
    x402Mocks.getUsdcBalanceDetailed.mockResolvedValueOnce({ balance: 0, network: "eip155:8453", ok: false });
    const reading = await readSelfhostedBalanceCents(ADDRESS);
    expect(reading).toEqual({ cents: 0, known: false });
  });
});

describe("check_credits heartbeat task — unknown balance never triggers death", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  function tick(overrides: Partial<TickContext>): TickContext {
    return {
      tickId: "tick-1",
      startedAt: new Date(),
      creditBalance: 0,
      creditBalanceKnown: true,
      usdcBalance: 0,
      survivalTier: "critical",
      lowComputeMultiplier: 4,
      config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
      db: db.raw,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });

  afterEach(() => {
    db.close();
  });

  it("does not start or advance the death countdown when the balance reading is unknown", async () => {
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({ hostingMode: "selfhosted" }),
      db,
      conway,
    };

    // Unknown zero reading, repeated: must never set zero_credits_since nor
    // transition to dead, however many times it ticks.
    for (let i = 0; i < 3; i++) {
      const result = await BUILTIN_TASKS.check_credits(
        tick({ creditBalance: 0, creditBalanceKnown: false, survivalTier: "critical" }),
        taskCtx,
      );
      expect(result.shouldWake).toBe(false);
    }
    expect(db.getKV("zero_credits_since")).toBeUndefined();
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("still dies after a KNOWN zero balance for over an hour (self-hosted mode)", async () => {
    const taskCtx: HeartbeatLegacyContext = {
      identity: createTestIdentity(),
      config: createTestConfig({ hostingMode: "selfhosted" }),
      db,
      conway,
    };

    await BUILTIN_TASKS.check_credits(
      tick({ creditBalance: 0, creditBalanceKnown: true, survivalTier: "critical" }),
      taskCtx,
    );
    expect(db.getKV("zero_credits_since")).toBeDefined();
    expect(db.getAgentState()).not.toBe("dead");

    // Simulate over an hour elapsed since the first known-zero reading.
    db.setKV("zero_credits_since", new Date(Date.now() - 3_700_000).toISOString());

    const result = await BUILTIN_TASKS.check_credits(
      tick({ creditBalance: 0, creditBalanceKnown: true, survivalTier: "critical" }),
      taskCtx,
    );
    expect(result.shouldWake).toBe(true);
    expect(db.getAgentState()).toBe("dead");
  });
});

describe("check_usdc_balance heartbeat task — no bootstrapTopup in selfhosted mode", () => {
  it("never attempts a credits topup in self-hosted mode even when USDC is available", async () => {
    const db = createTestDb();
    const conway = new MockConwayClient();
    try {
      const taskCtx: HeartbeatLegacyContext = {
        identity: createTestIdentity(),
        config: createTestConfig({ hostingMode: "selfhosted" }),
        db,
        conway,
      };
      const result = await BUILTIN_TASKS.check_usdc_balance(
        {
          tickId: "t1",
          startedAt: new Date(),
          creditBalance: 0,
          creditBalanceKnown: true,
          usdcBalance: 50,
          survivalTier: "critical",
          lowComputeMultiplier: 4,
          config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
          db: db.raw,
        },
        taskCtx,
      );
      expect(result.shouldWake).toBe(false);
      expect(db.getKV("last_auto_topup_attempt")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

// ─── 3. Backend selection never yields "conway" in selfhosted mode ─

describe("resolveInferenceBackend", () => {
  it("never resolves to conway in self-hosted mode, even with an unregistered model and no keys", () => {
    const backend = resolveInferenceBackend("some-unregistered-model", {
      hostingMode: "selfhosted",
      openaiCompatible: { baseUrl: "https://openrouter.ai/api", apiKeyEnv: "OPENROUTER_API_KEY" },
    });
    expect(backend).not.toBe("conway");
    expect(backend).toBe("openai_compatible");
  });

  it("routes a registry-tagged openai_compatible model to the openai_compatible backend", () => {
    const backend = resolveInferenceBackend("my-router-model", {
      hostingMode: "selfhosted",
      openaiCompatible: { baseUrl: "https://openrouter.ai/api", apiKeyEnv: "OPENROUTER_API_KEY" },
      getModelProvider: () => "openai_compatible",
    });
    expect(backend).toBe("openai_compatible");
  });

  it("conway mode is unchanged: unregistered model with no keys still resolves to conway", () => {
    const backend = resolveInferenceBackend("some-unregistered-model", {});
    expect(backend).toBe("conway");
  });
});

// ─── 4. OpenAI-compatible request: base URL + Bearer key from env ──

describe("createInferenceClient — openai_compatible backend", () => {
  const ENV_VAR = "SELFHOSTED_TEST_OPENROUTER_KEY";

  beforeEach(() => {
    process.env[ENV_VAR] = "sk-test-secret";
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("sends the request to the configured base URL with a Bearer key read from the env var", async () => {
    httpRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "resp_1",
          model: "my-model",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const inference = createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "conway-key-should-not-be-used",
      defaultModel: "my-model",
      maxTokens: 1024,
      hostingMode: "selfhosted",
      openaiCompatible: { baseUrl: "https://openrouter.ai/api", apiKeyEnv: ENV_VAR },
      getModelProvider: () => "openai_compatible",
    });

    const response = await inference.chat([{ role: "user", content: "hello" }]);
    expect(response.message.content).toBe("hi");

    expect(httpRequest).toHaveBeenCalledTimes(1);
    const [url, options] = httpRequest.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer sk-test-secret");
  });
});

// ─── 5. Configured models registered with prices, selected by tier ─

describe("configureSelfhostedModels + InferenceRouter", () => {
  let rawDb: BetterSqlite3.Database;

  beforeEach(() => {
    rawDb = new Database(":memory:");
    rawDb.pragma("journal_mode = WAL");
    rawDb.exec(MIGRATION_V6);
  });

  afterEach(() => {
    rawDb.close();
  });

  it("registers configured models with converted prices and disables the Conway/OpenAI baseline", () => {
    const registry = new ModelRegistry(rawDb);
    registry.initialize();
    expect(registry.get("gpt-5.2")?.enabled).toBe(true); // baseline enabled before configuring

    configureSelfhostedModels(registry, {
      openaiCompatible: {
        baseUrl: "https://openrouter.ai/api",
        apiKeyEnv: "OPENROUTER_API_KEY",
        models: [
          { id: "router/default-model", tier: "default", costPer1kInputCents: 0.2, costPer1kOutputCents: 0.8 },
          { id: "router/cheap-model", tier: "low_compute", costPer1kInputCents: 0.01, costPer1kOutputCents: 0.02 },
        ],
      },
    });

    const defaultEntry = registry.get("router/default-model");
    expect(defaultEntry).toBeDefined();
    expect(defaultEntry!.provider).toBe("openai_compatible");
    expect(defaultEntry!.tierMinimum).toBe("normal");
    // Config is cents/1k; registry stores hundredths-of-a-cent/1k (x100).
    expect(defaultEntry!.costPer1kInput).toBe(20);
    expect(defaultEntry!.costPer1kOutput).toBe(80);
    expect(defaultEntry!.enabled).toBe(true);

    const cheapEntry = registry.get("router/cheap-model");
    expect(cheapEntry!.tierMinimum).toBe("low_compute");

    // Baseline models are disabled so the router never reaches for them.
    expect(registry.get("gpt-5.2")?.enabled).toBe(false);
    expect(registry.get("gpt-5-mini")?.enabled).toBe(false);
  });

  it("the router selects the configured self-hosted model instead of the disabled baseline", async () => {
    const registry = new ModelRegistry(rawDb);
    registry.initialize();
    configureSelfhostedModels(registry, {
      openaiCompatible: {
        baseUrl: "https://openrouter.ai/api",
        apiKeyEnv: "OPENROUTER_API_KEY",
        models: [
          { id: "router/default-model", tier: "default", costPer1kInputCents: 0.2, costPer1kOutputCents: 0.8 },
          { id: "router/cheap-model", tier: "low_compute", costPer1kInputCents: 0.01, costPer1kOutputCents: 0.02 },
        ],
      },
    });

    const modelStrategy = deriveSelfhostedModelStrategy(
      [
        { id: "router/default-model", tier: "default", costPer1kInputCents: 0.2, costPer1kOutputCents: 0.8 },
        { id: "router/cheap-model", tier: "low_compute", costPer1kInputCents: 0.01, costPer1kOutputCents: 0.02 },
      ],
      DEFAULT_MODEL_STRATEGY_CONFIG,
    );
    const budget = new InferenceBudgetTracker(rawDb, modelStrategy);
    const router = new InferenceRouter(rawDb, registry, budget);

    // "normal" tier routing-matrix candidates (gpt-5.2/gpt-5-mini) are all
    // disabled, so selectModel must fall back to the configured strategy.
    const normalSelection = router.selectModel("normal", "agent_turn");
    expect(normalSelection?.modelId).toBe("router/default-model");

    const lowComputeSelection = router.selectModel("low_compute", "agent_turn");
    expect(lowComputeSelection?.modelId).toBe("router/cheap-model");
  });
});

// ─── 6. Conway-only tools are hidden in self-hosted mode ───────────

describe("createBuiltinTools — self-hosted tool visibility", () => {
  const HIDDEN_NAMES = [
    "check_credits",
    "topup_credits",
    "transfer_credits",
    "create_sandbox",
    "delete_sandbox",
    "list_sandboxes",
    "spawn_child",
    "list_children",
    "fund_child",
    "check_child_status",
    "start_child",
    "message_child",
    "verify_child_constitution",
    "prune_dead_children",
    "send_message",
    "list_models",
    "search_domains",
    "register_domain",
    "manage_dns",
  ];

  it("hides every Conway-only tool and adds check_balance in selfhosted mode", () => {
    const tools = createBuiltinTools("test-sandbox", "selfhosted");
    const names = new Set(tools.map((t) => t.name));
    for (const hidden of HIDDEN_NAMES) {
      expect(names.has(hidden)).toBe(false);
    }
    expect(names.has("check_balance")).toBe(true);
    // x402_fetch stays available (governed by the existing domain allowlist).
    expect(names.has("x402_fetch")).toBe(true);
    // Orchestration still works via the local worker pool.
    expect(names.has("create_goal")).toBe(true);
  });

  it("conway mode (default) is unchanged — every tool is still present", () => {
    const toolsDefault = createBuiltinTools("test-sandbox");
    const toolsExplicitConway = createBuiltinTools("test-sandbox", "conway");
    const namesDefault = new Set(toolsDefault.map((t) => t.name));
    const namesConway = new Set(toolsExplicitConway.map((t) => t.name));
    for (const hidden of HIDDEN_NAMES) {
      expect(namesDefault.has(hidden)).toBe(true);
      expect(namesConway.has(hidden)).toBe(true);
    }
    expect(namesDefault.has("check_balance")).toBe(false);
  });
});

// ─── 7. expose_port via Cloudflare quick tunnels ───────────────────

interface FakeChildProcess {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: () => void;
  on: (event: string, listener: (...args: any[]) => void) => FakeChildProcess;
  emit: (event: string, ...args: any[]) => boolean;
}

function createFakeChild(): FakeChildProcess {
  const emitter = new EventEmitter();
  const fake: FakeChildProcess = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 4242,
    kill: vi.fn(),
    on: (event, listener) => {
      emitter.on(event, listener);
      return fake;
    },
    emit: (event, ...args) => emitter.emit(event, ...args),
  };
  return fake;
}

describe("Cloudflare quick tunnels (expose_port / remove_port)", () => {
  it("parses the trycloudflare.com URL from cloudflared's output", async () => {
    const fakeChild = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => fakeChild as any);

    const pending = openQuickTunnel(8080, { spawnFn, timeoutMs: 5000 });
    // cloudflared prints its tunnel URL to stderr.
    fakeChild.stderr.emit(
      "data",
      Buffer.from("2026-10-14T00:00:00Z INF |  https://random-words-here.trycloudflare.com  |\n"),
    );

    const handle = await pending;
    expect(handle.url).toBe("https://random-words-here.trycloudflare.com");
    expect(handle.port).toBe(8080);

    const closed = closeQuickTunnel(8080);
    expect(closed).toBe(true);
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it("errors with a clear message when cloudflared is not installed", async () => {
    const fakeChild = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => fakeChild as any);

    const pending = openQuickTunnel(8081, { spawnFn, timeoutMs: 5000 });
    const enoent = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
    fakeChild.emit("error", enoent);

    await expect(pending).rejects.toThrow(/cloudflared is not installed/i);
  });

  it("removing a port with no tracked tunnel reports that cleanly", () => {
    expect(closeQuickTunnel(9999)).toBe(false);
  });
});
