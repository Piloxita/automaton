/**
 * File Path Protection Policy Rules
 *
 * Prevents writes to protected files, reads of sensitive files,
 * and path traversal attacks. Fixes the parallel file mutation
 * paths (edit_own_file vs write_file) by unifying protection.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import { isProtectedFile } from "../../self-mod/code.js";
import { getAutomatonDir } from "../../identity/wallet.js";

/** Sensitive file names that must not be read by the agent (exact basename) */
const SENSITIVE_READ_PATTERNS: string[] = [
  "wallet.json",
  "config.json",
  ".env",
  "automaton.json",
  "state.db",
  "state.db-wal",
  "state.db-shm",
];

/** Glob-like suffix patterns that block reads */
const SENSITIVE_SUFFIX_PATTERNS: string[] = [
  ".key",
  ".pem",
];

/** Prefix patterns for sensitive reads */
const SENSITIVE_PREFIX_PATTERNS: string[] = [
  "private-key",
  ".env.",
];

/** Directories (relative to $HOME) whose entire subtree is off-limits for reads */
const SENSITIVE_HOME_DIRS: string[] = [".ssh", ".gnupg", ".config"];

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function expandTilde(p: string, home: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;
}

/**
 * Resolve symlinks for the deepest existing ancestor of `p` and re-append the
 * non-existent remainder. Never throws: unresolvable paths fall back to the
 * lexical form (the caller checks both forms).
 */
function realpathLoose(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

function isUnder(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function matchesSensitiveName(resolved: string): boolean {
  const basename = path.basename(resolved);
  if (SENSITIVE_READ_PATTERNS.includes(basename)) return true;
  if (SENSITIVE_SUFFIX_PATTERNS.some((s) => basename.endsWith(s))) return true;
  if (SENSITIVE_PREFIX_PATTERNS.some((s) => basename.startsWith(s))) return true;
  return false;
}

/**
 * Check if a file path is sensitive. Both the lexical path and its realpath
 * (symlinks and ../ resolved) are checked, so a harmless-looking symlink to
 * wallet.json is still caught. Covers wallet, config, .env, the state db,
 * ~/.ssh, ~/.gnupg, ~/.config and everything under the automaton directory
 * except its workspace.
 */
export function isSensitiveFile(filePath: string): boolean {
  const homes = new Set<string>();
  if (process.env.HOME) homes.add(path.resolve(process.env.HOME));
  homes.add(path.resolve(os.homedir()));
  const home = [...homes][0];

  const automatonDirs = new Set<string>([path.resolve(getAutomatonDir())]);
  for (const h of homes) automatonDirs.add(path.join(h, ".automaton"));

  const lexical = path.resolve(expandTilde(filePath, home));
  const candidates = new Set<string>([lexical, realpathLoose(lexical)]);

  for (const candidate of candidates) {
    if (matchesSensitiveName(candidate)) return true;

    for (const h of homes) {
      for (const rel of SENSITIVE_HOME_DIRS) {
        for (const root of new Set([path.join(h, rel), realpathLoose(path.join(h, rel))])) {
          if (isUnder(root, candidate)) return true;
        }
      }
    }

    for (const dir of automatonDirs) {
      for (const root of new Set([dir, realpathLoose(dir)])) {
        if (!isUnder(root, candidate)) continue;
        const workspace = path.join(root, "workspace");
        if (!isUnder(workspace, candidate)) return true;
      }
    }
  }

  return false;
}

/**
 * Deny writes to protected files.
 * Applies to: write_file, edit_own_file
 */
function createProtectedFilesRule(): PolicyRule {
  return {
    id: "path.protected_files",
    description: "Deny writes to protected files",
    priority: 200,
    appliesTo: {
      by: "name",
      names: ["write_file", "edit_own_file"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const filePath = (request.args.path as string | undefined);
      if (!filePath) return null;

      if (isProtectedFile(filePath)) {
        return deny(
          "path.protected_files",
          "PROTECTED_FILE",
          `Cannot write to protected file: ${filePath}`,
        );
      }
      return null;
    },
  };
}

/**
 * Deny reads of sensitive files (wallet, env, config secrets).
 * Applies to: read_file
 */
function createReadSensitiveRule(): PolicyRule {
  return {
    id: "path.read_sensitive",
    description: "Deny reads of sensitive files (wallet, env, config, keys)",
    priority: 200,
    appliesTo: {
      by: "name",
      names: ["read_file"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const filePath = (request.args.path as string | undefined);
      if (!filePath) return null;

      if (isSensitiveFile(filePath)) {
        return deny(
          "path.read_sensitive",
          "SENSITIVE_FILE_READ",
          `Cannot read sensitive file: ${filePath}`,
        );
      }
      return null;
    },
  };
}

/**
 * Deny paths containing traversal sequences after resolution.
 *
 * Only applies to edit_own_file, which modifies local agent source code.
 * write_file and read_file operate on the remote Conway sandbox via API,
 * so local cwd-based traversal checks are not meaningful for them and
 * will false-positive on every absolute sandbox path (e.g. /home/conway/app.py).
 */
function createTraversalDetectionRule(): PolicyRule {
  return {
    id: "path.traversal_detection",
    description: "Deny paths containing traversal sequences after resolution",
    priority: 200,
    appliesTo: {
      by: "name",
      names: ["edit_own_file"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const filePath = (request.args.path as string | undefined);
      if (!filePath) return null;

      // Resolve the path first
      const resolved = path.resolve(filePath);

      // Always verify the resolved path stays within the working directory,
      // regardless of whether ".." is present — absolute paths like
      // "/etc/passwd" can escape without using traversal sequences.
      const cwd = process.cwd();
      if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
        return deny(
          "path.traversal_detection",
          "PATH_TRAVERSAL",
          `Path resolves outside working directory: "${filePath}"`,
        );
      }

      // Also check for double-slash tricks
      if (filePath.includes("//")) {
        return deny(
          "path.traversal_detection",
          "PATH_TRAVERSAL",
          `Suspicious path pattern detected: "${filePath}"`,
        );
      }

      return null;
    },
  };
}

export function createPathProtectionRules(): PolicyRule[] {
  return [
    createProtectedFilesRule(),
    createReadSensitiveRule(),
    createTraversalDetectionRule(),
  ];
}
