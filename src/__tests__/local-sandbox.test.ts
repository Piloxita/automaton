/**
 * Local sandbox tests: mode resolution, bwrap profile, host-side file
 * confinement, and (when bwrap works on this machine) real escape attempts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildBwrapArgs,
  createLocalSandbox,
  enforceAutomatonPermissions,
  ensureWorkspaceDir,
  findBwrap,
  getWorkspaceDir,
  LOCAL_EXEC_DISABLED_MESSAGE,
  probeBwrap,
  resolveLocalExecMode,
  resolveWorkspacePath,
  SandboxPathError,
} from "../sandbox/local-sandbox.js";
import { createConwayClient } from "../conway/client.js";

const bwrapPath = findBwrap();
const bwrapWorks = (() => {
  if (!bwrapPath) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-probe-"));
  try {
    return probeBwrap(bwrapPath, fs.realpathSync(dir)).ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string; // fake HOME
let automatonDir: string;
let workspace: string;
const SECRET = "0xDEADBEEF_SECRET_PRIVATE_KEY";

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-test-")));
  automatonDir = path.join(root, ".automaton");
  fs.mkdirSync(automatonDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(automatonDir, "wallet.json"), JSON.stringify({ privateKey: SECRET }), { mode: 0o644 });
  fs.writeFileSync(path.join(automatonDir, "automaton.json"), JSON.stringify({ conwayApiKey: SECRET }));
  workspace = ensureWorkspaceDir(getWorkspaceDir(automatonDir));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveLocalExecMode", () => {
  it("defaults to bwrap when installed, disabled otherwise", () => {
    expect(resolveLocalExecMode(undefined, "/usr/bin/bwrap")).toBe("bwrap");
    expect(resolveLocalExecMode(undefined, null)).toBe("disabled");
  });

  it("fails closed when bwrap is requested but missing", () => {
    expect(resolveLocalExecMode("bwrap", null)).toBe("disabled");
  });

  it("only returns unsafe-host when explicitly configured", () => {
    expect(resolveLocalExecMode("unsafe-host", null)).toBe("unsafe-host");
    expect(resolveLocalExecMode(undefined, null)).not.toBe("unsafe-host");
  });

  it("treats unknown values as disabled", () => {
    expect(resolveLocalExecMode("yolo", "/usr/bin/bwrap")).toBe("disabled");
    expect(resolveLocalExecMode(42, "/usr/bin/bwrap")).toBe("disabled");
  });
});

describe("buildBwrapArgs", () => {
  it("applies the isolation profile and mounts only the workspace from the home tree", () => {
    const args = buildBwrapArgs(workspace);
    for (const flag of ["--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv"]) {
      expect(args).toContain(flag);
    }
    // --clearenv must precede --setenv
    expect(args.indexOf("--clearenv")).toBeLessThan(args.indexOf("--setenv"));
    const binds: string[] = [];
    args.forEach((a, i) => {
      if (a === "--bind" || a === "--ro-bind" || a === "--ro-bind-try") binds.push(args[i + 1]);
    });
    expect(binds).toContain(workspace);
    expect(binds).not.toContain(automatonDir);
    expect(binds).not.toContain(root);
    expect(args.join(" ")).toContain("--chdir /workspace");
  });
});

describe("workspace permissions", () => {
  it("creates the workspace 0700 and tightens the automaton dir and secrets", () => {
    expect(fs.statSync(workspace).mode & 0o777).toBe(0o700);
    expect(fs.statSync(automatonDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(automatonDir, "wallet.json")).mode & 0o777).toBe(0o600);
  });

  it("enforceAutomatonPermissions fixes loose modes", () => {
    fs.chmodSync(automatonDir, 0o755);
    fs.chmodSync(path.join(automatonDir, "automaton.json"), 0o666);
    expect(enforceAutomatonPermissions(automatonDir)).toEqual([]);
    expect(fs.statSync(automatonDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(automatonDir, "automaton.json")).mode & 0o777).toBe(0o600);
  });
});

describe("resolveWorkspacePath / host-side file confinement", () => {
  it("maps virtual paths into the workspace", () => {
    expect(resolveWorkspacePath("a.txt", workspace)).toBe(path.join(workspace, "a.txt"));
    expect(resolveWorkspacePath("~/a.txt", workspace)).toBe(path.join(workspace, "a.txt"));
    expect(resolveWorkspacePath("/workspace/sub/a.txt", workspace)).toBe(path.join(workspace, "sub", "a.txt"));
    expect(resolveWorkspacePath("/root/a.txt", workspace)).toBe(path.join(workspace, "a.txt"));
    expect(resolveWorkspacePath(path.join(workspace, "x"), workspace)).toBe(path.join(workspace, "x"));
  });

  it("rejects ../ traversal and absolute paths outside the workspace", () => {
    expect(() => resolveWorkspacePath("../wallet.json", workspace)).toThrow(SandboxPathError);
    expect(() => resolveWorkspacePath("/workspace/../wallet.json", workspace)).toThrow(SandboxPathError);
    expect(() => resolveWorkspacePath("/root/../etc/passwd", workspace)).toThrow(SandboxPathError);
    expect(() => resolveWorkspacePath(path.join(automatonDir, "wallet.json"), workspace)).toThrow(SandboxPathError);
    expect(() => resolveWorkspacePath("/etc/passwd", workspace)).toThrow(SandboxPathError);
    expect(() => resolveWorkspacePath("a\0b", workspace)).toThrow(SandboxPathError);
  });

  it("rejects a symlink inside the workspace that points out", () => {
    fs.symlinkSync(path.join(automatonDir, "wallet.json"), path.join(workspace, "evil"));
    expect(() => resolveWorkspacePath("evil", workspace)).toThrow(SandboxPathError);
    const sbx = createLocalSandbox({ mode: "disabled", workspaceDir: workspace });
    expect(() => sbx.readFile("evil")).toThrow(SandboxPathError);
    expect(() => sbx.writeFile("evil", "overwrite")).toThrow(SandboxPathError);
    expect(fs.readFileSync(path.join(automatonDir, "wallet.json"), "utf-8")).toContain(SECRET);
  });

  it("rejects a symlinked directory pointing out, even for not-yet-existing children", () => {
    fs.symlinkSync(automatonDir, path.join(workspace, "dirlink"));
    const sbx = createLocalSandbox({ mode: "disabled", workspaceDir: workspace });
    expect(() => sbx.readFile("dirlink/wallet.json")).toThrow(SandboxPathError);
    expect(() => sbx.writeFile("dirlink/new.txt", "x")).toThrow(SandboxPathError);
    expect(fs.existsSync(path.join(automatonDir, "new.txt"))).toBe(false);
  });

  it("rejects a dangling symlink that points outside", () => {
    fs.symlinkSync(path.join(root, "does-not-exist-yet"), path.join(workspace, "dangling"));
    const sbx = createLocalSandbox({ mode: "disabled", workspaceDir: workspace });
    expect(() => sbx.writeFile("dangling", "x")).toThrow(SandboxPathError);
    expect(fs.existsSync(path.join(root, "does-not-exist-yet"))).toBe(false);
  });

  it("allows a symlink that stays inside the workspace", () => {
    fs.writeFileSync(path.join(workspace, "real.txt"), "hello");
    fs.symlinkSync(path.join(workspace, "real.txt"), path.join(workspace, "alias.txt"));
    const sbx = createLocalSandbox({ mode: "disabled", workspaceDir: workspace });
    expect(sbx.readFile("alias.txt")).toBe("hello");
  });

  it("writes and reads regular files, creating parents", () => {
    const sbx = createLocalSandbox({ mode: "disabled", workspaceDir: workspace });
    sbx.writeFile("/root/deep/nested/f.txt", "content");
    expect(fs.readFileSync(path.join(workspace, "deep/nested/f.txt"), "utf-8")).toBe("content");
    expect(sbx.readFile("~/deep/nested/f.txt")).toBe("content");
    sbx.writeFile("deep/nested/f.txt", "short");
    expect(sbx.readFile("/workspace/deep/nested/f.txt")).toBe("short");
  });

  it("does not hang on FIFOs", async () => {
    const { execFileSync } = await import("child_process");
    execFileSync("mkfifo", [path.join(workspace, "pipe")]);
    const sbx = createLocalSandbox({ mode: "disabled", workspaceDir: workspace });
    expect(() => sbx.readFile("pipe")).toThrow();
  });
});

describe("createLocalSandbox modes", () => {
  it("disabled mode refuses exec with an explanation", () => {
    const sbx = createLocalSandbox({ mode: "disabled", workspaceDir: workspace });
    const r = sbx.exec("echo hi");
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(LOCAL_EXEC_DISABLED_MESSAGE);
  });

  it("bwrap requested but unavailable fails closed (never runs on host)", () => {
    const sbx = createLocalSandbox({ mode: "bwrap", bwrapPath: null, workspaceDir: workspace });
    expect(sbx.mode).toBe("disabled");
    expect(sbx.exec("echo hi").exitCode).not.toBe(0);
  });

  it("unset mode with no bwrap is disabled", () => {
    const sbx = createLocalSandbox({ bwrapPath: null, workspaceDir: workspace });
    expect(sbx.mode).toBe("disabled");
  });

  it("unsafe-host runs on the host only when explicitly requested", () => {
    const sbx = createLocalSandbox({ mode: "unsafe-host" });
    expect(sbx.mode).toBe("unsafe-host");
    expect(sbx.exec("echo host-ok").stdout.trim()).toBe("host-ok");
  });
});

describe.skipIf(!bwrapWorks)("bwrap isolation (real)", () => {
  const run = (cmd: string, timeout?: number) =>
    createLocalSandbox({ mode: "bwrap", workspaceDir: workspace }).exec(cmd, timeout);

  it("runs commands, returns output and exit codes, cwd is /workspace", () => {
    expect(run("pwd").stdout.trim()).toBe("/workspace");
    expect(run("echo $HOME").stdout.trim()).toBe("/workspace");
    const r = run("echo out; echo err >&2; exit 3");
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
    expect(r.exitCode).toBe(3);
  });

  it("cannot read the wallet or config by any tool, by absolute host path", () => {
    const wallet = path.join(automatonDir, "wallet.json");
    const config = path.join(automatonDir, "automaton.json");
    for (const cmd of [
      `cat ${wallet}`,
      `head -c 100 ${wallet}`,
      `cp ${wallet} /workspace/stolen.json`,
      `cat ${config}`,
      `bash -c 'exec 3< ${wallet}; cat <&3'`,
      `ls ${automatonDir}`,
      `ls ${root}`,
    ]) {
      const r = run(cmd);
      expect(r.exitCode, cmd).not.toBe(0);
      expect(r.stdout, cmd).not.toContain(SECRET);
    }
    expect(fs.existsSync(path.join(workspace, "stolen.json"))).toBe(false);
  });

  it("cannot reach the wallet through ~, ../ or find", () => {
    const outputs = [
      run("cat ~/.automaton/wallet.json"),
      run("cat ../.automaton/wallet.json"),
      run("cat /workspace/../.automaton/wallet.json"),
      run(`find / -name wallet.json 2>/dev/null`),
    ];
    for (const r of outputs) {
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stdout).not.toContain("wallet.json");
    }
  });

  it("can write inside /workspace (and /root alias) and the host sees it", () => {
    expect(run("echo data > /workspace/out.txt").exitCode).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "out.txt"), "utf-8").trim()).toBe("data");
    expect(run("echo data2 > /root/out2.txt").exitCode).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "out2.txt"), "utf-8").trim()).toBe("data2");
    expect(run("cat out.txt").stdout.trim()).toBe("data");
  });

  it("cannot modify system directories; /tmp is private and ephemeral", () => {
    expect(run("touch /usr/pwned").exitCode).not.toBe(0);
    expect(run("touch /etc/pwned").exitCode).not.toBe(0);
    expect(run("echo x > /tmp/jail-only").exitCode).toBe(0);
    expect(fs.existsSync("/tmp/jail-only")).toBe(false);
  });

  it("does not leak host environment variables", () => {
    process.env.AUTOMATON_TEST_SECRET = SECRET;
    try {
      const r = run("env");
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stdout).toContain("HOME=/workspace");
    } finally {
      delete process.env.AUTOMATON_TEST_SECRET;
    }
  });

  it("passes the command as a single argv entry (no host-side shell interpolation)", () => {
    const r = run(`echo "$(echo nested)" '; echo injected'`);
    expect(r.stdout.trim()).toBe("nested ; echo injected");
  });

  it("kills commands that exceed the timeout", () => {
    const start = Date.now();
    const r = run("sleep 20", 500);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("timed out");
  });

  it("a symlink created in the jail pointing at host secrets cannot be used via host-side file ops", () => {
    run(`ln -s ${path.join(automatonDir, "wallet.json")} /workspace/link`);
    const sbx = createLocalSandbox({ mode: "bwrap", workspaceDir: workspace });
    expect(() => sbx.readFile("link")).toThrow(SandboxPathError);
  });
});

describe("ConwayClient in local mode", () => {
  const makeClient = (mode: "bwrap" | "disabled" | "unsafe-host") =>
    createConwayClient({
      apiUrl: "http://127.0.0.1:1",
      apiKey: "test",
      sandboxId: "",
      localExecMode: mode,
      localWorkspaceDir: workspace,
    });

  it("confines writeFile/readFile to the workspace", async () => {
    const client = makeClient("disabled");
    await client.writeFile("/root/notes.txt", "hi");
    expect(await client.readFile("/workspace/notes.txt")).toBe("hi");
    await expect(client.readFile(path.join(automatonDir, "wallet.json"))).rejects.toThrow(/outside the workspace/);
    await expect(client.writeFile("../.automaton/wallet.json", "x")).rejects.toThrow(/outside the workspace/);
    await expect(client.readFile("~/../.automaton/wallet.json")).rejects.toThrow();
    expect(fs.readFileSync(path.join(automatonDir, "wallet.json"), "utf-8")).toContain(SECRET);
  });

  it("disabled mode makes exec return an error instead of running on the host", async () => {
    const r = await makeClient("disabled").exec("echo should-not-run");
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it.skipIf(!bwrapWorks)("bwrap mode sees files written via writeFile", async () => {
    const client = makeClient("bwrap");
    await client.writeFile("hello.txt", "from-host");
    const r = await client.exec("cat /root/hello.txt");
    expect(r.stdout).toBe("from-host");
  });
});
