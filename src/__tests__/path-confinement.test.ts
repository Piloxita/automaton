/**
 * Realpath-based sensitive-file detection, the shared command blocklist, and
 * the read_file/exec tool handlers wired to them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isSensitiveFile } from "../agent/policy-rules/path-protection.js";
import { getForbiddenCommandMatch } from "../agent/policy-rules/command-safety.js";
import { createBuiltinTools } from "../agent/tools.js";
import { MockConwayClient, MockInferenceClient, createTestDb, createTestIdentity, createTestConfig } from "./mocks.js";
import type { ToolContext } from "../types.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pc-test-")));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".automaton", "workspace"), { recursive: true });
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(path.join(home, ".gnupg"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "app"), { recursive: true });
  fs.writeFileSync(path.join(home, ".automaton", "wallet.json"), "{}");
  fs.writeFileSync(path.join(home, ".automaton", "heartbeat.yml"), "x");
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "k");
  fs.writeFileSync(path.join(home, ".config", "app", "token"), "t");
  fs.writeFileSync(path.join(home, "notes.txt"), "n");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("isSensitiveFile (realpath based)", () => {
  it("blocks well-known sensitive names anywhere", () => {
    for (const p of [
      "/x/wallet.json", "/x/automaton.json", "/x/config.json", "/x/.env", "/x/.env.local",
      "/x/state.db", "/x/state.db-wal", "/x/server.key", "/x/cert.pem", "/x/private-key-1",
    ]) {
      expect(isSensitiveFile(p), p).toBe(true);
    }
  });

  it("blocks ~/.ssh, ~/.gnupg, ~/.config subtrees and ~ expansion", () => {
    expect(isSensitiveFile(path.join(home, ".ssh", "id_ed25519"))).toBe(true);
    expect(isSensitiveFile("~/.ssh/id_ed25519")).toBe(true);
    expect(isSensitiveFile(path.join(home, ".gnupg", "pubring.kbx"))).toBe(true);
    expect(isSensitiveFile(path.join(home, ".config", "app", "token"))).toBe(true);
  });

  it("blocks anything under ~/.automaton except the workspace", () => {
    expect(isSensitiveFile(path.join(home, ".automaton", "heartbeat.yml"))).toBe(true);
    expect(isSensitiveFile(path.join(home, ".automaton", "skills", "x", "SKILL.md"))).toBe(true);
    expect(isSensitiveFile(path.join(home, ".automaton", "workspace", "notes.txt"))).toBe(false);
    expect(isSensitiveFile(path.join(home, "notes.txt"))).toBe(false);
  });

  it("blocks ../ traversal into sensitive paths", () => {
    expect(isSensitiveFile(path.join(home, ".automaton", "workspace", "..", "heartbeat.yml"))).toBe(true);
    expect(isSensitiveFile(path.join(home, "notes.txt", "..", ".ssh", "id_ed25519"))).toBe(true);
  });

  it("blocks symlinks that resolve to sensitive files", () => {
    const ws = path.join(home, ".automaton", "workspace");
    fs.symlinkSync(path.join(home, ".automaton", "heartbeat.yml"), path.join(ws, "innocent.txt"));
    fs.symlinkSync(path.join(home, ".ssh", "id_ed25519"), path.join(home, "notes-link.txt"));
    fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "dirlink"));
    expect(isSensitiveFile(path.join(ws, "innocent.txt"))).toBe(true);
    expect(isSensitiveFile(path.join(home, "notes-link.txt"))).toBe(true);
    expect(isSensitiveFile(path.join(home, "dirlink", "id_ed25519"))).toBe(true);
    // not-yet-existing child below a symlinked dir
    expect(isSensitiveFile(path.join(home, "dirlink", "future-key"))).toBe(true);
  });

  it("allows ordinary files", () => {
    expect(isSensitiveFile(path.join(home, "notes.txt"))).toBe(false);
    expect(isSensitiveFile("/workspace/app.py")).toBe(false);
    expect(isSensitiveFile("/root/project/README.md")).toBe(false);
  });
});

describe("shared exec blocklist (command-safety)", () => {
  it.each([
    "cat ~/.automaton/wallet.json",
    "head -c 200 ~/.automaton/wallet.json",
    "jq .privateKey ~/.automaton/wallet.json",
    `node -e "console.log(require('fs').readFileSync('/home/u/.automaton/wallet.json','utf8'))"`,
    "cp ~/.automaton/wallet.json /tmp/w",
    "cat ~/.automaton/automaton.json",
    "sqlite3 ~/.automaton/state.db .dump",
    "ls ~/.ssh",
    "tar c ~/.gnupg",
    "tail ~/project/.env",
    "cat /proc/1/environ",
  ])("blocks %s", (cmd) => {
    expect(getForbiddenCommandMatch(cmd)).not.toBeNull();
  });

  it.each(["ls -la", "echo hello > out.txt", "python3 app.py", "git status", "curl https://example.com"])(
    "allows %s",
    (cmd) => {
      expect(getForbiddenCommandMatch(cmd)).toBeNull();
    },
  );
});

describe("tool handlers", () => {
  let ctx: ToolContext;
  let conway: MockConwayClient;
  let db: ReturnType<typeof createTestDb>;
  const tool = (name: string) => createBuiltinTools("sbx-id").find((t) => t.name === name)!;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    ctx = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference: new MockInferenceClient(),
    };
  });
  afterEach(() => db.close());

  it("read_file blocks a symlink to the wallet and never reaches the client", async () => {
    const link = path.join(home, "harmless.txt");
    fs.symlinkSync(path.join(home, ".automaton", "wallet.json"), link);
    const result = await tool("read_file").execute({ path: link }, ctx);
    expect(result).toContain("Blocked");
    expect(conway.execCalls.length).toBe(0);
  });

  it("read_file blocks ../ traversal and ~/.ssh", async () => {
    const t = tool("read_file");
    expect(await t.execute({ path: path.join(home, "notes.txt", "..", ".ssh", "id_ed25519") }, ctx)).toContain("Blocked");
    expect(await t.execute({ path: "~/.ssh/id_ed25519" }, ctx)).toContain("Blocked");
  });

  it.each(["head -n1 ~/.automaton/wallet.json", "jq . ~/.automaton/wallet.json", "cp ~/.automaton/wallet.json ."])(
    "exec tool blocks %s before reaching the client",
    async (command) => {
      const result = await tool("exec").execute({ command }, ctx);
      expect(result).toContain("Blocked");
      expect(conway.execCalls.length).toBe(0);
    },
  );
});
