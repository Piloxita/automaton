/**
 * Self-hosted stand-in for UnifiedInferenceClient.
 *
 * The orchestrator, planner, memory compression and local workers normally
 * call providers through the OpenAI SDK (provider-registry). In self-hosted
 * mode the only endpoint is the creator-configured OpenAI-compatible one,
 * which may be a unix socket (the host Claude relay) that the SDK cannot
 * reach. This adapter sends those calls through the main inference client
 * instead, mapping tiers to the configured models.
 */
import type { ChatMessage, InferenceClient } from "../types.js";
import type { UnifiedInferenceResult } from "./inference-client.js";
import type { ModelTier } from "./provider-registry.js";

interface ChatParams {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  responseFormat?: { type: "json_object" | "text" };
}

export interface SelfhostedTierModels {
  reasoning: string;
  fast: string;
  cheap: string;
}

export class SelfhostedUnifiedClient {
  constructor(
    private readonly inference: Pick<InferenceClient, "chat">,
    private readonly models: SelfhostedTierModels,
  ) {}

  async chat(params: ChatParams & { tier: ModelTier }): Promise<UnifiedInferenceResult> {
    return this.call(params, this.models[params.tier] ?? this.models.fast, params.tier);
  }

  async chatDirect(params: ChatParams & { providerId: string; modelId: string }): Promise<UnifiedInferenceResult> {
    return this.call(params, params.modelId, "fast");
  }

  private async call(params: ChatParams, model: string, tier: ModelTier): Promise<UnifiedInferenceResult> {
    const messages =
      params.responseFormat?.type === "json_object"
        ? [...params.messages, { role: "system" as const, content: "Respond with a single valid JSON object only." }]
        : params.messages;
    const started = Date.now();
    const response = await this.inference.chat(messages, {
      model,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      tools: params.tools as any,
    });
    return {
      content: response.message?.content ?? "",
      toolCalls: response.toolCalls,
      usage: {
        inputTokens: response.usage?.promptTokens ?? 0,
        outputTokens: response.usage?.completionTokens ?? 0,
        totalTokens: response.usage?.totalTokens ?? 0,
      },
      cost: { inputCostCredits: 0, outputCostCredits: 0, totalCostCredits: 0 },
      metadata: {
        providerId: "selfhosted",
        modelId: model,
        tier,
        latencyMs: Date.now() - started,
        retries: 0,
        failedProviders: [],
      },
    };
  }
}
