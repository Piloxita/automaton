/**
 * Upstream Awareness
 *
 * Helpers for the automaton to know its own git origin,
 * detect new upstream commits, and review diffs.
 * All git commands use execFileSync with argument arrays to prevent injection.
 */

import { execFileSync } from "child_process";
import type { AutomatonConfig } from "../types.js";

const REPO_ROOT = process.cwd();

/**
 * Run a git command using execFileSync with argument array (no shell interpolation).
 */
function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();
}

/**
 * Return origin URL (credentials stripped), current branch, and HEAD info.
 */
export function getRepoInfo(): {
  originUrl: string;
  branch: string;
  headHash: string;
  headMessage: string;
} {
  const rawUrl = git(["config", "--get", "remote.origin.url"]);
  // Strip embedded credentials (https://user:token@host/... -> https://host/...)
  const originUrl = rawUrl.replace(/\/\/[^@]+@/, "//");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headLine = git(["log", "-1", "--format=%h %s"]);
  const [headHash, ...rest] = headLine.split(" ");
  return { originUrl, branch, headHash, headMessage: rest.join(" ") };
}

/** Remote ref the configured upstream is fetched into (never `origin`). */
export const UPSTREAM_TRACKING_REF = "refs/automaton/upstream";

/**
 * Install without running dependency lifecycle scripts. The only package
 * allowed to run its install script is better-sqlite3 (native build).
 */
export const LIFECYCLE_SCRIPT_ALLOWLIST: readonly string[] = Object.freeze(["better-sqlite3"]);
export const SAFE_INSTALL_AND_BUILD_COMMAND =
  `npm ci --ignore-scripts && npm rebuild ${LIFECYCLE_SCRIPT_ALLOWLIST.join(" ")} && npm run build`;

export interface UpstreamTarget {
  url: string;
  ref: string;
}

const UPSTREAM_NOT_CONFIGURED =
  "No upstream configured. The creator must set upstreamRepoUrl (and optionally upstreamRef) in automaton.json before upstream pulls, resets or child spawning are possible.";

/** Accept https:// or ssh:// / git@host:path URLs without credentials, whitespace or option-like prefixes. */
export function isSafeRepoUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 512) return false;
  if (/[\s'"`$;&|<>\\]/.test(url) || url.startsWith("-")) return false;
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/-]+$/.test(url)) return true;
  if (/^ssh:\/\/git@[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/-]+$/.test(url)) return true;
  return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/-]+$/.test(url);
}

export function isSafeGitRef(ref: string): boolean {
  return (
    typeof ref === "string" &&
    /^[A-Za-z0-9._\/-]{1,200}$/.test(ref) &&
    !ref.startsWith("-") &&
    !ref.includes("..")
  );
}

/**
 * Resolve the creator-configured upstream. Returns an error string when none
 * is configured or the values are unsafe (fail closed).
 */
export function resolveUpstream(
  config: Pick<AutomatonConfig, "upstreamRepoUrl" | "upstreamRef"> | undefined,
): { target: UpstreamTarget } | { error: string } {
  const url = config?.upstreamRepoUrl?.trim();
  if (!url) return { error: UPSTREAM_NOT_CONFIGURED };
  if (!isSafeRepoUrl(url)) {
    return { error: "Configured upstreamRepoUrl is not an acceptable git URL (https:// or ssh only, no credentials)." };
  }
  const ref = (config?.upstreamRef?.trim() || "main");
  if (!isSafeGitRef(ref)) {
    return { error: "Configured upstreamRef is not a valid git ref name." };
  }
  return { target: { url, ref } };
}

function fetchUpstream(target: UpstreamTarget): void {
  git(["fetch", "--quiet", "--no-tags", target.url, `+${target.ref}:${UPSTREAM_TRACKING_REF}`]);
}

/**
 * Fetch the configured upstream and report how many commits we're behind.
 */
export function checkUpstream(target: UpstreamTarget): {
  behind: number;
  commits: { hash: string; message: string }[];
} {
  fetchUpstream(target);
  const log = git(["log", `HEAD..${UPSTREAM_TRACKING_REF}`, "--oneline"]);
  if (!log) return { behind: 0, commits: [] };
  const commits = log.split("\n").map((line) => {
    const [hash, ...rest] = line.split(" ");
    return { hash, message: rest.join(" ") };
  });
  return { behind: commits.length, commits };
}

/**
 * Return per-commit diffs for every commit ahead of HEAD on the configured upstream.
 * Call checkUpstream first (it performs the fetch).
 */
export function getUpstreamDiffs(): {
  hash: string;
  message: string;
  author: string;
  diff: string;
}[] {
  const log = git(["log", `HEAD..${UPSTREAM_TRACKING_REF}`, "--format=%H %an|||%s"]);
  if (!log) return [];

  return log.split("\n").map((line) => {
    const [hashAndAuthor, message] = line.split("|||");
    const parts = hashAndAuthor.split(" ");
    const hash = parts[0];
    const author = parts.slice(1).join(" ");
    let diff: string;
    try {
      diff = git(["diff", `${hash}~1..${hash}`]);
    } catch {
      // First commit in the range may not have a parent
      diff = git(["show", hash, "--format=", "--stat"]);
    }
    return { hash: hash.slice(0, 12), message, author, diff };
  });
}
