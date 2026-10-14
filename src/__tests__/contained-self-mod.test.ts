/**
 * Contained self-modification profile: inside the creator's container the agent
 * may edit its own source (tools, loop, policy code), but never the
 * constitution, its config/wallet/soul files, or generated/vendored trees.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { isContainedProfile, isProtectedFile } from "../self-mod/code.js";

const repo = path.resolve("/tmp/fake-automaton-repo");

describe("isContainedProfile", () => {
  it("needs both the creator env flag and a container marker", () => {
    const marker = (p: string) => p === "/run/.containerenv";
    expect(isContainedProfile({ AUTOMATON_CONTAINED: "1" }, marker)).toBe(true);
    expect(isContainedProfile({ AUTOMATON_CONTAINED: "1" }, () => false)).toBe(false);
    expect(isContainedProfile({}, marker)).toBe(false);
    expect(isContainedProfile({ AUTOMATON_CONTAINED: "true" }, marker)).toBe(false);
  });
});

describe("isProtectedFile in the contained profile", () => {
  const prot = (rel: string) => isProtectedFile(path.join(repo, rel), repo, true);

  it("lets the agent edit its own source, including tools and policy code", () => {
    for (const rel of ["src/agent/tools.ts", "src/agent/loop.ts", "src/survival/spend-guard.ts", "src/index.ts", "package.json", "src/new-service/api.ts"]) {
      expect(prot(rel)).toBe(false);
    }
  });

  it("keeps the constitution, identity, config and generated trees protected", () => {
    for (const rel of ["constitution.md", "dist/index.js", "node_modules/x/index.js", ".git/config"]) {
      expect(prot(rel)).toBe(true);
    }
    for (const p of ["/root/.automaton/automaton.json", "/root/.automaton/wallet.json", "/root/.automaton/SOUL.md", "/root/.automaton/constitution.md"]) {
      expect(isProtectedFile(p, repo, true)).toBe(true);
    }
  });

  it("is not used outside a container: the strict list still applies", () => {
    expect(isProtectedFile(path.join(repo, "src/agent/tools.ts"), repo, false)).toBe(true);
  });
});
