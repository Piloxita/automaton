/**
 * Hosting Mode — pure decision helpers.
 *
 * "conway" (default): the agent depends on Conway's hosted API (sandboxes,
 * credits, inference, social relay). "selfhosted": no Conway dependency at
 * all — the agent runs in its own container, pays for inference from a
 * capped OpenAI-compatible key, and tracks survival via its own USDC balance.
 *
 * Kept small and dependency-free (no I/O) so each decision can be unit
 * tested directly, without spinning up the database, wallet, or network.
 */

import type { AutomatonConfig, ModelStrategyConfig } from "./types.js";

export type HostingMode = "conway" | "selfhosted";

export function getHostingMode(config: Pick<AutomatonConfig, "hostingMode">): HostingMode {
  return config.hostingMode === "selfhosted" ? "selfhosted" : "conway";
}

export function isSelfHosted(config: Pick<AutomatonConfig, "hostingMode">): boolean {
  return getHostingMode(config) === "selfhosted";
}

/** Startup: a Conway API key is only required when running in Conway hosting mode. */
export function requiresConwayApiKey(config: Pick<AutomatonConfig, "hostingMode">): boolean {
  return !isSelfHosted(config);
}

/** One-time ERC-8004-adjacent Conway identity registration — Conway-only. */
export function shouldRegisterWithConway(config: Pick<AutomatonConfig, "hostingMode">): boolean {
  return !isSelfHosted(config);
}

/** Buying Conway credits with USDC makes no sense when USDC IS the balance. */
export function shouldBootstrapTopup(config: Pick<AutomatonConfig, "hostingMode">): boolean {
  return !isSelfHosted(config);
}

/**
 * Self-hosted mode has no Conway dependency at all, so the social relay
 * (which defaults to Conway's) is disabled entirely rather than trying to
 * distinguish a creator-configured non-Conway relay.
 */
export function shouldCreateSocialClient(
  config: Pick<AutomatonConfig, "hostingMode" | "socialRelayUrl">,
): boolean {
  return !isSelfHosted(config) && !!config.socialRelayUrl;
}

/** The periodic Conway /v1/models refresh heartbeat task is Conway-only. */
export function shouldRefreshConwayModels(config: Pick<AutomatonConfig, "hostingMode">): boolean {
  return !isSelfHosted(config);
}

type OpenAiCompatibleModelConfig = NonNullable<AutomatonConfig["openaiCompatible"]>["models"][number];

/**
 * Point the model strategy's inferenceModel/lowComputeModel/criticalModel at
 * the creator-configured OpenAI-compatible models, keyed by tier. Falls back
 * to the "default" tier (or the first model) when a tier has no dedicated
 * model configured.
 */
export function deriveSelfhostedModelStrategy(
  models: OpenAiCompatibleModelConfig[] | undefined,
  base: ModelStrategyConfig,
): ModelStrategyConfig {
  if (!models || models.length === 0) return base;
  const byTier = (tier: string) => models.find((m) => (m.tier ?? "default") === tier);
  const defaultModel = byTier("default") ?? models[0];
  const lowComputeModel = byTier("low_compute") ?? defaultModel;
  const criticalModel = byTier("critical") ?? lowComputeModel;
  return {
    ...base,
    inferenceModel: defaultModel.id,
    lowComputeModel: lowComputeModel.id,
    criticalModel: criticalModel.id,
  };
}
