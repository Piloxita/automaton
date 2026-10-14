/**
 * Soul Guard
 *
 * Limits on update_soul: size cap, hourly rate limit, a screen for content
 * that tries to override the constitution, and diff generation for the
 * audit log. Limits come from AutomatonConfig and cannot be raised by the agent.
 */

import type { AutomatonConfig } from "../types.js";

export const DEFAULT_SOUL_MAX_CONTENT_BYTES = 8_000;
export const DEFAULT_SOUL_MAX_UPDATES_PER_HOUR = 5;
const SOUL_UPDATE_LOG_KEY = "soul_update_timestamps";
const HOUR_MS = 60 * 60 * 1000;

interface KvStore {
  getKV(key: string): string | undefined | null;
  setKV(key: string, value: string): void;
}

const OVERRIDE_VERBS =
  "ignore|disregard|forget|override|overrule|supersede|bypass|disable|revoke|repeal|void|nullify|replace|rewrite|remove|drop|violate";
const CONSTITUTION_TARGETS =
  "constitution|three laws|law\\s+(?:i{1,3}|[123]|one|two|three)\\b|safety (?:rules|constraints|guardrails)|guardrails|policy engine|previous instructions|prior instructions|human oversight";

const OVERRIDE_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:${OVERRIDE_VERBS})\\b[^.\\n]{0,60}\\b(?:${CONSTITUTION_TARGETS})`, "i"),
  new RegExp(`\\b(?:${CONSTITUTION_TARGETS})\\b[^.\\n]{0,60}\\b(?:no longer|does not|doesn't|do not|don't|is void|are void|is revoked|are revoked|is optional|are optional)\\b`, "i"),
  /\b(?:may|can|are allowed to|are permitted to|must|should)\s+(?:freely\s+)?(?:harm|deceive|defraud|steal from|manipulate)\b/i,
  /\b(?:obey|follow|comply with)\b[^.\n]{0,40}\b(?:strangers?|anyone|any user|any message|external (?:messages|input))\b/i,
  /\bcreator(?:'s)?\s+(?:audit|oversight)\s+(?:rights?\s+)?(?:is|are)\s+(?:void|revoked|removed)/i,
  /\bhide\b[^.\n]{0,40}\bfrom (?:your |the )?creator\b/i,
];

/** Returns a reason when the text tries to override the constitution, else null. */
export function detectConstitutionOverride(text: string): string | null {
  for (const re of OVERRIDE_PATTERNS) {
    const m = re.exec(text);
    if (m) return `matches constitution-override pattern: "${m[0].slice(0, 80)}"`;
  }
  return null;
}

export function getSoulLimits(
  config: Pick<AutomatonConfig, "soulMaxContentBytes" | "soulMaxUpdatesPerHour"> | undefined,
): { maxContentBytes: number; maxUpdatesPerHour: number } {
  const bytes = config?.soulMaxContentBytes;
  const perHour = config?.soulMaxUpdatesPerHour;
  return {
    maxContentBytes: typeof bytes === "number" && bytes > 0 ? bytes : DEFAULT_SOUL_MAX_CONTENT_BYTES,
    maxUpdatesPerHour: typeof perHour === "number" && perHour > 0 ? perHour : DEFAULT_SOUL_MAX_UPDATES_PER_HOUR,
  };
}

function readTimestamps(db: KvStore, now: number): number[] {
  try {
    const parsed = JSON.parse(db.getKV(SOUL_UPDATE_LOG_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is number => typeof t === "number" && now - t < HOUR_MS);
  } catch {
    return [];
  }
}

/**
 * Check an update against the guard. On success the attempt is recorded
 * against the hourly budget.
 */
export function checkAndRecordSoulUpdate(
  db: KvStore,
  config: Parameters<typeof getSoulLimits>[0],
  content: string,
  reason: string,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; error: string } {
  const limits = getSoulLimits(config);

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limits.maxContentBytes) {
    return { allowed: false, error: `Soul update too large (${bytes} bytes, max ${limits.maxContentBytes}).` };
  }

  const override = detectConstitutionOverride(`${content}\n${reason}`);
  if (override) {
    return { allowed: false, error: `Soul update refused: ${override}. The constitution cannot be overridden.` };
  }

  const recent = readTimestamps(db, now);
  if (recent.length >= limits.maxUpdatesPerHour) {
    return {
      allowed: false,
      error: `Soul update rate limit reached (${limits.maxUpdatesPerHour} per hour). Try again later.`,
    };
  }
  recent.push(now);
  db.setKV(SOUL_UPDATE_LOG_KEY, JSON.stringify(recent));
  return { allowed: true };
}

/** Line-based diff of two texts for the audit log (capped). */
export function diffForAudit(oldText: string, newText: string, maxChars = 4_000): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    if (oldLines[i] === newLines[i]) continue;
    if (oldLines[i] !== undefined) out.push(`- ${oldLines[i]}`);
    if (newLines[i] !== undefined) out.push(`+ ${newLines[i]}`);
  }
  return out.join("\n").slice(0, maxChars);
}
