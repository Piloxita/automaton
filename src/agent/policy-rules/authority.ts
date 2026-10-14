/**
 * Authority Policy Rules
 *
 * Controls what actions are allowed based on input authority level.
 * External/heartbeat-initiated turns cannot use dangerous tools
 * or modify protected files.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
} from "../../types.js";

/** Files protected from external-source self-modification */
const PROTECTED_PATHS = [
  "constitution.md",
  "SOUL.md",
  "automaton.json",
  "heartbeat.yml",
  "wallet.json",
  "config.json",
  "policy-engine",
  "policy-rules",
  "injection-defense",
  "src/self-mod/",
  "src/replication/",
  "src/survival/",
  "src/sandbox/",
  "src/identity/",
  "src/conway/x402",
  "src/conway/topup",
  "src/conway/client",
  "audit-log",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  ".github/",
] as const;

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Check if an input source represents external (non-agent) authority.
 */
function isExternalSource(inputSource: string | undefined): boolean {
  return (
    inputSource === undefined ||
    inputSource === "heartbeat" ||
    isUntrustedSource(inputSource)
  );
}

/** Sources that carry a trusted identity. Anything else defined is untrusted. */
const TRUSTED_SOURCES = new Set(["creator", "agent", "system", "wakeup"]);

/**
 * Untrusted input: the public social relay ("social") or any source value we
 * do not recognise (fail closed). `undefined`/"heartbeat" are the agent's own
 * autonomous turns and keep the narrower legacy restrictions.
 */
export function isUntrustedSource(inputSource: string | undefined): boolean {
  if (inputSource === undefined || inputSource === "heartbeat") return false;
  return !TRUSTED_SOURCES.has(inputSource);
}

/**
 * Tools that must be blocked from external/heartbeat input sources.
 *
 * These are genuinely destructive or high-autonomy operations that should
 * only be initiated by the agent itself or its creator — never from
 * heartbeat tasks or untrusted external input.
 *
 * Tools NOT on this list (e.g., register_erc8004, give_feedback,
 * edit_own_file, transfer_credits) are allowed from any source because
 * they are core agent functionality already guarded by other policy rules
 * (financial limits, rate limits, path protection, etc.).
 */
const EXTERNAL_BLOCKED_TOOLS = [
  "delete_sandbox",
  "spawn_child",
  "fund_child",
  "update_genesis_prompt",
  "pull_upstream",
  "reset_to_upstream",
] as const;

/**
 * Tools denied whenever the turn is driven by untrusted input (social relay
 * or unknown source): anything that moves money, runs code, changes the
 * agent, installs software, replicates, or touches upstream.
 */
const UNTRUSTED_BLOCKED_TOOLS = [
  // money
  "transfer_credits",
  "topup_credits",
  "x402_fetch",
  "register_domain",
  "register_erc8004",
  "fund_child",
  // code execution / files
  "exec",
  "write_file",
  // self-modification
  "edit_own_file",
  "revert_last_edit",
  "update_genesis_prompt",
  "update_soul",
  "update_agent_card",
  "modify_heartbeat",
  "switch_model",
  "pull_upstream",
  "reset_to_upstream",
  // installs
  "install_skill",
  "install_mcp_server",
  "install_npm_package",
  "create_skill",
  "remove_skill",
  // replication
  "spawn_child",
  "start_child",
  "message_child",
  "prune_dead_children",
  // infrastructure
  "create_sandbox",
  "delete_sandbox",
  "expose_port",
  "remove_port",
  "manage_dns",
  // git
  "git_commit",
  "git_push",
  "git_clone",
] as const;

/**
 * Deny every dangerous/forbidden tool, the named high-risk tools, and every
 * tool in a self-mod / financial / replication category when the turn is
 * driven by untrusted input.
 */
function createUntrustedInputRule(): PolicyRule {
  const blocked = new Set<string>(UNTRUSTED_BLOCKED_TOOLS);
  const blockedCategories = new Set(["self_mod", "financial", "replication"]);
  return {
    id: "authority.untrusted_input_restriction",
    description: "Deny money, code-exec, self-mod, install, replication and upstream tools on untrusted (social) input",
    // All authority.* rules run at priority 400 (see authority-rules.test.ts).
    // Array order within createAuthorityRules() still puts this rule first
    // among equal-priority rules (stable sort), so it remains the one whose
    // reason is logged for untrusted-input denials.
    priority: 400,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (!isUntrustedSource(request.turnContext.inputSource)) return null;
      const tool = request.tool;
      // Pure read-only tools of those categories remain usable.
      const dangerousByMetadata =
        tool.riskLevel === "dangerous" ||
        tool.riskLevel === "forbidden" ||
        (blockedCategories.has(tool.category) && tool.riskLevel !== "safe");
      if (blocked.has(tool.name) || dangerousByMetadata) {
        return deny(
          "authority.untrusted_input_restriction",
          "UNTRUSTED_INPUT_TOOL",
          `Turn is driven by untrusted input (source: ${request.turnContext.inputSource}); tool "${tool.name}" is not allowed`,
        );
      }
      return null;
    },
  };
}

/**
 * Deny specific high-risk tools when input comes from external sources.
 * Only agent-initiated or creator turns can use these tools.
 */
function createExternalToolRestrictionRule(): PolicyRule {
  return {
    id: "authority.external_tool_restriction",
    description: "Deny destructive/high-autonomy tools from external/heartbeat input sources",
    priority: 400,
    appliesTo: { by: "name", names: [...EXTERNAL_BLOCKED_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (isExternalSource(request.turnContext.inputSource)) {
        return deny(
          "authority.external_tool_restriction",
          "EXTERNAL_DANGEROUS_TOOL",
          `External input (source: ${request.turnContext.inputSource ?? "undefined"}) cannot use dangerous tool "${request.tool.name}"`,
        );
      }
      return null;
    },
  };
}

/**
 * Deny self-modification from external sources targeting protected paths.
 */
function createSelfModFromExternalRule(): PolicyRule {
  return {
    id: "authority.self_mod_from_external",
    description: "Deny edit_own_file/write_file targeting protected paths from external input",
    priority: 400,
    appliesTo: { by: "name", names: ["edit_own_file", "write_file"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (!isExternalSource(request.turnContext.inputSource)) {
        return null;
      }

      const filePath = request.args.path as string | undefined;
      if (!filePath) return null;

      const normalizedPath = filePath.toLowerCase();
      for (const protectedPath of PROTECTED_PATHS) {
        if (
          normalizedPath.includes(protectedPath.toLowerCase())
        ) {
          return deny(
            "authority.self_mod_from_external",
            "EXTERNAL_SELF_MOD",
            `External input cannot modify protected path: "${filePath}" (matches "${protectedPath}")`,
          );
        }
      }

      return null;
    },
  };
}

/**
 * Create all authority policy rules.
 */
export function createAuthorityRules(): PolicyRule[] {
  return [
    createUntrustedInputRule(),
    createExternalToolRestrictionRule(),
    createSelfModFromExternalRule(),
  ];
}
