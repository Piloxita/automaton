import { describe, it, expect, vi } from "vitest";
import { SelfhostedUnifiedClient } from "../inference/selfhosted-unified-client.js";

describe("SelfhostedUnifiedClient", () => {
  const reply = {
    id: "x", model: "m", finishReason: "stop",
    message: { role: "assistant" as const, content: "ok" },
    toolCalls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };

  it("routes tiers to the configured models through the main inference client", async () => {
    const chat = vi.fn(async () => reply);
    const client = new SelfhostedUnifiedClient({ chat } as any, { reasoning: "big", fast: "big", cheap: "small" });
    const r = await client.chat({ tier: "cheap", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    expect(chat).toHaveBeenCalledWith([{ role: "user", content: "hi" }], expect.objectContaining({ model: "small", maxTokens: 100 }));
    expect(r.content).toBe("ok");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.usage.totalTokens).toBe(15);
    expect(r.metadata.modelId).toBe("small");
  });

  it("asks for JSON when a json_object response format is requested", async () => {
    const chat = vi.fn(async () => reply);
    const client = new SelfhostedUnifiedClient({ chat } as any, { reasoning: "big", fast: "big", cheap: "small" });
    await client.chat({ tier: "reasoning", messages: [{ role: "user", content: "plan" }], responseFormat: { type: "json_object" } });
    const sent = (chat.mock.calls[0] as any[])[0] as Array<{ role: string; content: string }>;
    expect(sent[sent.length - 1].content).toMatch(/JSON/);
  });
});
