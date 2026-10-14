/**
 * Cloudflare Quick Tunnels — self-hosted mode's replacement for Conway's
 * exposePort/removePort API. Runs `cloudflared tunnel --url http://localhost:<port>`
 * as a detached-from-logic (but tracked) child process and parses the
 * https://*.trycloudflare.com URL it prints on startup.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type SpawnFn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => ChildProcess;

export interface QuickTunnelHandle {
  process: ChildProcess;
  url: string;
  port: number;
}

const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com\S*/;

const activeTunnels = new Map<number, QuickTunnelHandle>();

/**
 * Start a cloudflared quick tunnel for `port` and resolve once it reports a
 * trycloudflare.com URL (or reject on timeout / missing binary / early exit).
 */
export async function openQuickTunnel(
  port: number,
  options?: { timeoutMs?: number; spawnFn?: SpawnFn },
): Promise<QuickTunnelHandle> {
  const spawnFn = options?.spawnFn ?? nodeSpawn;
  const timeoutMs = options?.timeoutMs ?? 30_000;

  return new Promise<QuickTunnelHandle>((resolve, reject) => {
    let settled = false;

    const child = spawnFn(
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // best effort
      }
      reject(new Error(`Timed out waiting for cloudflared to report a tunnel URL (${timeoutMs}ms)`));
    }, timeoutMs);

    const handleChunk = (chunk: Buffer | string) => {
      if (settled) return;
      const text = chunk.toString();
      const match = text.match(TRYCLOUDFLARE_URL_RE);
      if (match) {
        settled = true;
        clearTimeout(timer);
        const handle: QuickTunnelHandle = { process: child, url: match[0], port };
        activeTunnels.set(port, handle);
        resolve(handle);
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "cloudflared is not installed or not on PATH. Install it from " +
              "https://github.com/cloudflare/cloudflared/releases/latest to use expose_port in self-hosted mode.",
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before reporting a tunnel URL (exit code ${code})`));
    });
  });
}

/** Kill the tracked tunnel process for `port`. Returns false if none was tracked. */
export function closeQuickTunnel(port: number): boolean {
  const handle = activeTunnels.get(port);
  if (!handle) return false;
  try {
    handle.process.kill();
  } catch {
    // best effort
  }
  activeTunnels.delete(port);
  return true;
}

export function getQuickTunnel(port: number): QuickTunnelHandle | undefined {
  return activeTunnels.get(port);
}

/** Test-only: clear in-memory tunnel tracking between test cases. */
export function resetQuickTunnelsForTests(): void {
  activeTunnels.clear();
}
