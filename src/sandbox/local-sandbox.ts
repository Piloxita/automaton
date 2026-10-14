/**
 * Local isolated execution.
 *
 * When the automaton has no remote Conway sandbox, shell commands used to run
 * directly on the host. This module replaces that with a bubblewrap (bwrap)
 * jail whose only writable mount is a dedicated workspace directory, and
 * confines host-side file reads/writes to that same directory.
 *
 * Enforcement lives here (in the host process), not in prompts or regexes:
 * ~/.automaton (wallet, config, db) is never mounted into the jail, and file
 * access is checked against realpaths so symlinks and ../ cannot escape.
 */

import { spawnSync, execSync } from "child_process";
import fs from "fs";
import os from "os";
import nodePath from "path";
import type { ExecResult } from "../types.js";

export type LocalExecMode = "bwrap" | "disabled" | "unsafe-host";

export const LOCAL_EXEC_MODES: readonly LocalExecMode[] = ["bwrap", "disabled", "unsafe-host"];

/** Where the workspace appears inside the jail (and the virtual home for file tools). */
/**
 * Network for the jail.
 * "isolated": own network namespace via pasta (passt). Internet works, but the
 *   host's loopback services (127.0.0.1 dashboards, local APIs) are unreachable.
 * "none": no network at all.
 * "host": share the host network, including its localhost (explicit opt-in only).
 */
export type JailNetwork = "isolated" | "none" | "host";

export const VIRTUAL_WORKSPACE = "/workspace";
/** write_file historically confines to /root; it is aliased to the workspace. */
const VIRTUAL_HOME_ALIAS = "/root";

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const JAIL_PATH = "/usr/local/bin:/usr/bin:/bin";

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPathError";
  }
}

// ─── Mode resolution ─────────────────────────────────────────────

export function findBwrap(envPath: string | undefined = process.env.PATH): string | null {
  return findBinary("bwrap", envPath);
}

export function findPasta(envPath: string | undefined = process.env.PATH): string | null {
  return findBinary("pasta", envPath);
}

function findBinary(name: string, envPath: string | undefined): string | null {
  for (const dir of (envPath || "").split(nodePath.delimiter)) {
    if (!dir) continue;
    const candidate = nodePath.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Resolve the effective mode. Unset -> bwrap if installed, else disabled.
 * Requesting bwrap without it installed, or an unknown value, fails closed.
 */
export function resolveLocalExecMode(
  configured: unknown,
  bwrapPath: string | null = findBwrap(),
): LocalExecMode {
  if (configured === undefined || configured === null || configured === "") {
    return bwrapPath ? "bwrap" : "disabled";
  }
  if (configured === "bwrap") return bwrapPath ? "bwrap" : "disabled";
  if (configured === "disabled" || configured === "unsafe-host") return configured;
  return "disabled";
}

/**
 * Resolve the jail network. Unset -> "isolated" if pasta is installed, else
 * "none". Requesting "isolated" without pasta, or an unknown value, fails
 * closed to "none". "host" is only used when explicitly set.
 */
export function resolveJailNetwork(
  configured: unknown,
  pastaPath: string | null = findPasta(),
): JailNetwork {
  if (configured === undefined || configured === null || configured === "" || configured === "isolated") {
    return pastaPath ? "isolated" : "none";
  }
  if (configured === "none" || configured === "host") return configured;
  return "none";
}

export const LOCAL_EXEC_DISABLED_MESSAGE =
  "Local command execution is disabled: no isolated sandbox is available. " +
  'The human creator can enable it by installing bubblewrap (package "bubblewrap"/"bwrap") ' +
  'and setting "localExecMode": "bwrap" in ~/.automaton/automaton.json, or by configuring a ' +
  "remote Conway sandbox (sandboxId). Running on the bare host requires explicitly setting " +
  '"localExecMode": "unsafe-host" and is not recommended.';

// ─── Directories and permissions ─────────────────────────────────

export function getWorkspaceDir(automatonDir?: string): string {
  const base = automatonDir ?? nodePath.join(process.env.HOME || os.homedir() || "/root", ".automaton");
  return nodePath.join(base, "workspace");
}

const SECRET_FILES_0600 = [
  "wallet.json",
  "automaton.json",
  "config.json",
  "state.db",
  "state.db-wal",
  "state.db-shm",
];

/**
 * Force owner-only permissions on the automaton directory and its secret files.
 * Returns the paths that could not be fixed (e.g. owned by another user).
 */
export function enforceAutomatonPermissions(automatonDir: string): string[] {
  const failed: string[] = [];
  const tryChmod = (p: string, mode: number) => {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, mode);
    } catch {
      failed.push(p);
    }
  };
  tryChmod(automatonDir, 0o700);
  for (const name of SECRET_FILES_0600) {
    tryChmod(nodePath.join(automatonDir, name), 0o600);
  }
  return failed;
}

/** Create the workspace (0700) and tighten the permissions of its parent. */
export function ensureWorkspaceDir(workspaceDir: string): string {
  const parent = nodePath.dirname(workspaceDir);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  enforceAutomatonPermissions(parent);
  if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(workspaceDir, 0o700);
  } catch {
    // best effort; confinement does not depend on the mode
  }
  return fs.realpathSync(workspaceDir);
}

// ─── bwrap profile ───────────────────────────────────────────────

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Build the bwrap argv (without the leading "bwrap" and without the command).
 * The jail sees: read-only system dirs, an empty /tmp, /proc, /dev, and the
 * workspace at /workspace (also aliased at /root). Nothing else from the host.
 */
export function buildBwrapArgs(
  workspaceDir: string,
  network: JailNetwork = "none",
  jailResolvConf?: string,
): string[] {
  const args: string[] = [
    "--unshare-all",
    // "isolated" shares pasta's private namespace, not the host's.
    ...(network === "none" ? [] : ["--share-net"]),
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
    "--clearenv",
    "--setenv", "PATH", JAIL_PATH,
    "--setenv", "HOME", VIRTUAL_WORKSPACE,
    "--setenv", "LANG", "C.UTF-8",
  ];

  for (const dir of ["/usr", "/etc", "/opt"]) {
    if (lstatOrNull(dir)?.isDirectory()) args.push("--ro-bind", dir, dir);
  }

  for (const link of ["/bin", "/lib", "/lib64", "/sbin"]) {
    const st = lstatOrNull(link);
    if (!st) continue;
    if (st.isSymbolicLink()) args.push("--symlink", fs.readlinkSync(link), link);
    else if (st.isDirectory()) args.push("--ro-bind", link, link);
  }

  // /etc/resolv.conf is commonly a symlink into /run (e.g. the systemd-resolved
  // stub at 127.0.0.53), which is unreachable from a private namespace. In
  // "isolated" mode, mount a resolv.conf with public resolvers at its real path.
  try {
    const resolvReal = fs.realpathSync("/etc/resolv.conf");
    if (network === "isolated" && jailResolvConf) {
      args.push("--ro-bind", jailResolvConf, resolvReal);
    } else if (network === "host" && !resolvReal.startsWith("/etc/") && !resolvReal.startsWith("/usr/")) {
      const resolvDir = nodePath.dirname(resolvReal);
      if (resolvDir !== "/" && resolvDir.startsWith("/run/")) {
        args.push("--ro-bind-try", resolvDir, resolvDir);
      }
    }
  } catch {
    // no resolv.conf
  }

  args.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", workspaceDir, VIRTUAL_WORKSPACE,
    "--bind", workspaceDir, VIRTUAL_HOME_ALIAS,
    "--chdir", VIRTUAL_WORKSPACE,
  );
  return args;
}

const JAIL_DNS = ["1.1.1.1", "8.8.8.8"];

/** pasta options: own netns, no gateway mapping to host loopback, no port forwards. */
export function buildPastaArgs(): string[] {
  const args = ["--config-net", "--no-map-gw", "-T", "none", "-U", "none", "-t", "none", "-u", "none", "--quiet"];
  for (const ns of JAIL_DNS) args.push("-D", ns);
  return args;
}

export interface JailNetworkSetup {
  network: JailNetwork;
  pastaPath?: string | null;
  /** Host file mounted as the jail's resolv.conf in "isolated" mode. */
  jailResolvConf?: string;
}

export function execInBwrap(
  bwrapPath: string,
  workspaceDir: string,
  command: string,
  timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
  net: JailNetworkSetup = { network: "none" },
): ExecResult {
  if (net.network === "isolated" && !net.pastaPath) {
    return { stdout: "", stderr: "Isolated network requested but pasta is not available. Command NOT executed.", exitCode: 126 };
  }
  const jailArgv = [...buildBwrapArgs(workspaceDir, net.network, net.jailResolvConf), "--", "bash", "-c", command];
  const [bin, argv] = net.network === "isolated"
    ? [net.pastaPath as string, [...buildPastaArgs(), "--", bwrapPath, ...jailArgv]]
    : [bwrapPath, jailArgv];
  const r = spawnSync(bin, argv, {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    cwd: workspaceDir,
    env: { PATH: process.env.PATH || JAIL_PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = r.stdout || "";
  let stderr = r.stderr || "";
  if (net.network === "isolated") {
    // pasta warns about the host's loopback-only resolver; the jail uses its own.
    stderr = stderr.replace(/^Couldn't get any nameserver address\n?/m, "");
  }
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") {
    return { stdout, stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim(), exitCode: 124 };
  }
  if (code === "ENOBUFS") {
    return { stdout, stderr: `${stderr}\nOutput exceeded ${MAX_BUFFER} bytes; command killed`.trim(), exitCode: 1 };
  }
  if (r.error) {
    stderr = `${stderr}\n${r.error.message}`.trim();
    return { stdout, stderr, exitCode: 1 };
  }
  return { stdout, stderr, exitCode: r.status ?? 1 };
}

/** True if bwrap can actually create the jail (user namespaces permitted, etc). */
export function probeBwrap(
  bwrapPath: string,
  workspaceDir: string,
  net: JailNetworkSetup = { network: "none" },
): { ok: boolean; detail: string } {
  const r = execInBwrap(bwrapPath, workspaceDir, "true", 10_000, net);
  return { ok: r.exitCode === 0, detail: r.stderr.trim() };
}

// ─── Host-side file confinement ──────────────────────────────────

/**
 * Walk up to the deepest existing ancestor (lstat, so dangling symlinks count
 * as existing and are rejected by realpath), resolve it, re-append the rest.
 */
function realpathAllowMissing(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(cur);
      break;
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw new SandboxPathError(`Cannot resolve path: ${err?.code || err?.message}`);
      }
      const parent = nodePath.dirname(cur);
      if (parent === cur) break;
      tail.unshift(nodePath.basename(cur));
      cur = parent;
    }
  }
  let real: string;
  try {
    real = fs.realpathSync(cur);
  } catch (err: any) {
    throw new SandboxPathError(`Cannot resolve path (broken or looping symlink): ${err?.code || err?.message}`);
  }
  return tail.length ? nodePath.join(real, ...tail) : real;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + nodePath.sep);
}

/**
 * Map an agent-supplied path to a real host path inside the workspace, or throw.
 * Accepts: relative paths, ~/..., /workspace/..., /root/... (all virtual) and
 * absolute host paths that already point inside the workspace.
 */
export function resolveWorkspacePath(filePath: string, workspaceDir: string): string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new SandboxPathError("Path must be a non-empty string");
  }
  if (filePath.includes("\0")) throw new SandboxPathError("Path contains a NUL byte");

  const realWorkspace = fs.realpathSync(workspaceDir);

  let p = filePath;
  if (p === "~" || p.startsWith("~/")) p = VIRTUAL_WORKSPACE + p.slice(1);
  const abs = nodePath.posix.resolve(VIRTUAL_WORKSPACE, p);

  let hostCandidate: string | null = null;
  for (const root of [VIRTUAL_WORKSPACE, VIRTUAL_HOME_ALIAS]) {
    if (abs === root || abs.startsWith(root + "/")) {
      hostCandidate = nodePath.join(realWorkspace, abs.slice(root.length));
      break;
    }
  }
  if (hostCandidate === null) hostCandidate = abs;

  const real = realpathAllowMissing(hostCandidate);
  if (!isInside(realWorkspace, real)) {
    throw new SandboxPathError(
      `Path "${filePath}" resolves outside the workspace (${VIRTUAL_WORKSPACE}); only files inside the workspace are accessible.`,
    );
  }
  return real;
}

function assertFdInside(fd: number, realWorkspace: string): void {
  const real = fs.realpathSync(`/proc/self/fd/${fd}`);
  if (!isInside(realWorkspace, real)) {
    throw new SandboxPathError("Path changed during access and now resolves outside the workspace");
  }
}

export function writeWorkspaceFile(filePath: string, content: string, workspaceDir: string): void {
  const target = resolveWorkspacePath(filePath, workspaceDir);
  const realWorkspace = fs.realpathSync(workspaceDir);
  fs.mkdirSync(nodePath.dirname(target), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    0o600,
  );
  try {
    assertFdInside(fd, realWorkspace);
    if (!fs.fstatSync(fd).isFile()) throw new SandboxPathError("Not a regular file");
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, content, 0, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readWorkspaceFile(filePath: string, workspaceDir: string): string {
  const target = resolveWorkspacePath(filePath, workspaceDir);
  const realWorkspace = fs.realpathSync(workspaceDir);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    assertFdInside(fd, realWorkspace);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new SandboxPathError("Not a regular file");
    if (st.size > MAX_READ_BYTES) {
      throw new SandboxPathError(`File too large (${st.size} bytes, max ${MAX_READ_BYTES})`);
    }
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Sandbox facade used by the Conway client ────────────────────

export interface LocalSandbox {
  readonly mode: LocalExecMode;
  /** Jail network; absent in unsafe-host mode (the host network is used). */
  readonly network?: JailNetwork;
  readonly workspaceDir: string;
  exec(command: string, timeoutMs?: number): ExecResult;
  writeFile(filePath: string, content: string): void;
  readFile(filePath: string): string;
}

export interface LocalSandboxOptions {
  mode?: unknown;
  /** Host directory bound at /workspace. Default ~/.automaton/workspace. */
  workspaceDir?: string;
  /** Override bwrap lookup (tests). */
  bwrapPath?: string | null;
  /** Jail network: "isolated" (default if pasta installed), "none", or "host". */
  network?: unknown;
  /** Override pasta lookup (tests). */
  pastaPath?: string | null;
}

function writeJailResolvConf(workspaceDir: string): string {
  // Lives next to the workspace (in ~/.automaton), never inside it, so the jail cannot edit it.
  const file = nodePath.join(nodePath.dirname(workspaceDir), "jail-resolv.conf");
  fs.writeFileSync(file, JAIL_DNS.map((ns) => `nameserver ${ns}`).join("\n") + "\n", { mode: 0o644 });
  return file;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? nodePath.join(process.env.HOME || "/root", p.slice(1)) : p;
}

export function createLocalSandbox(options: LocalSandboxOptions = {}): LocalSandbox {
  const bwrapPath = options.bwrapPath === undefined ? findBwrap() : options.bwrapPath;
  const mode = resolveLocalExecMode(options.mode, bwrapPath);

  if (mode === "unsafe-host") {
    // Explicit opt-in to the legacy, unisolated behaviour.
    const home = process.env.HOME || "/root";
    return {
      mode,
      workspaceDir: home,
      exec(command, timeoutMs) {
        try {
          const stdout = execSync(command, {
            timeout: timeoutMs || DEFAULT_EXEC_TIMEOUT_MS,
            encoding: "utf-8",
            maxBuffer: MAX_BUFFER,
            cwd: home,
          });
          return { stdout: stdout || "", stderr: "", exitCode: 0 };
        } catch (err: any) {
          return { stdout: err.stdout || "", stderr: err.stderr || err.message || "", exitCode: err.status ?? 1 };
        }
      },
      writeFile(filePath, content) {
        const resolved = expandHome(filePath);
        fs.mkdirSync(nodePath.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf-8");
      },
      readFile(filePath) {
        return fs.readFileSync(expandHome(filePath), "utf-8");
      },
    };
  }

  const workspaceDir = ensureWorkspaceDir(options.workspaceDir ?? getWorkspaceDir());
  const pastaPath = options.pastaPath === undefined ? findPasta() : options.pastaPath;
  const network = resolveJailNetwork(options.network, pastaPath);
  const net: JailNetworkSetup = {
    network,
    pastaPath,
    jailResolvConf: network === "isolated" ? writeJailResolvConf(workspaceDir) : undefined,
  };
  let probe: { ok: boolean; detail: string } | null = null;

  return {
    mode,
    network,
    workspaceDir,
    exec(command, timeoutMs) {
      if (mode === "disabled" || !bwrapPath) {
        return { stdout: "", stderr: LOCAL_EXEC_DISABLED_MESSAGE, exitCode: 126 };
      }
      if (!probe) probe = probeBwrap(bwrapPath, workspaceDir, net);
      if (!probe.ok) {
        probe = null; // re-probe next time; never run unisolated
        return {
          stdout: "",
          stderr:
            "bubblewrap is installed but cannot create a sandbox (user namespaces may be disabled). " +
            "Command NOT executed. " + LOCAL_EXEC_DISABLED_MESSAGE,
          exitCode: 126,
        };
      }
      return execInBwrap(bwrapPath, workspaceDir, command, timeoutMs, net);
    },
    writeFile(filePath, content) {
      writeWorkspaceFile(filePath, content, workspaceDir);
    },
    readFile(filePath) {
      return readWorkspaceFile(filePath, workspaceDir);
    },
  };
}
