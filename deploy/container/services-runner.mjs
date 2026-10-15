// Keeps the agent's long-running services alive inside the container.
// The agent declares them in /root/.automaton/workspace/services.json:
//   [{"name": "api", "cwd": "/root/.automaton/workspace/api", "cmd": "node server.js",
//     "port": 3402, "public": true}]
// Each service is restarted when it exits (with backoff) and after container
// restarts; "public" ones get a Cloudflare quick tunnel, also kept alive.
// State for the agent and the creator's dashboard: workspace/services-status.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WS = "/root/.automaton/workspace";
const CONFIG = path.join(WS, "services.json");
const STATUS = path.join(WS, "services-status.json");
const LOGS = path.join(WS, "logs");
const MAX_SERVICES = 5;
const MAX_LOG = 5 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const running = new Map(); // name -> state

function log(msg) {
  console.log(`[services] ${msg}`);
}

function readConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, MAX_SERVICES)) {
    if (!s || typeof s !== "object") continue;
    const cwd = path.resolve(String(s.cwd || ""));
    if (!NAME_RE.test(String(s.name || "")) || !(cwd === WS || cwd.startsWith(WS + "/"))) continue;
    if (typeof s.cmd !== "string" || !s.cmd.trim()) continue;
    const port = Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535 ? s.port : null;
    out.push({ name: s.name, cwd, cmd: s.cmd, port, public: Boolean(s.public) && port !== null });
  }
  return out;
}

function logStream(name) {
  fs.mkdirSync(LOGS, { recursive: true });
  const file = path.join(LOGS, `${name}.log`);
  try {
    if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`);
  } catch {}
  return fs.createWriteStream(file, { flags: "a" });
}

function startProc(st) {
  if (!fs.existsSync(st.spec.cwd)) {
    st.lastError = `cwd does not exist: ${st.spec.cwd}`;
    return;
  }
  const out = logStream(st.spec.name);
  const child = spawn("sh", ["-c", st.spec.cmd], { cwd: st.spec.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  st.proc = child;
  st.startedAt = Date.now();
  st.lastError = null;
  child.on("exit", (code, signal) => {
    st.proc = null;
    st.lastExit = { code, signal, at: new Date().toISOString() };
    if (st.stopped) return;
    const ranMs = Date.now() - st.startedAt;
    st.backoff = ranMs > 60_000 ? 2_000 : Math.min((st.backoff || 2_000) * 2, 300_000);
    st.restarts += 1;
    setTimeout(() => !st.stopped && startProc(st), st.backoff);
  });
}

function startTunnel(st) {
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${st.spec.port}`],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  st.tunnel = child;
  st.url = null;
  const onData = (buf) => {
    const m = buf.toString().match(URL_RE);
    if (m && !st.url) {
      st.url = m[0];
      log(`${st.spec.name}: public at ${st.url}`);
      writeStatus();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => { st.lastError = `cloudflared: ${e.message}`; });
  child.on("exit", () => {
    st.tunnel = null;
    st.url = null;
    if (!st.stopped && st.spec.public) setTimeout(() => !st.stopped && startTunnel(st), 10_000);
  });
}

function kill(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function stop(st) {
  st.stopped = true;
  kill(st.proc);
  kill(st.tunnel);
}

async function health(st) {
  if (!st.spec.port || !st.proc) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${st.spec.port}/`, { signal: AbortSignal.timeout(5_000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

function writeStatus() {
  const services = [...running.values()].map((st) => ({
    name: st.spec.name, cmd: st.spec.cmd, cwd: st.spec.cwd, port: st.spec.port, public: st.spec.public,
    running: Boolean(st.proc), pid: st.proc?.pid ?? null, restarts: st.restarts, lastExit: st.lastExit ?? null,
    lastError: st.lastError ?? null, url: st.url ?? null, healthy: st.healthy ?? null,
    log: path.join(LOGS, `${st.spec.name}.log`),
  }));
  try {
    fs.writeFileSync(`${STATUS}.tmp`, JSON.stringify({ updated: new Date().toISOString(), services }, null, 2));
    fs.renameSync(`${STATUS}.tmp`, STATUS);
  } catch {}
}

function reconcile() {
  const wanted = new Map(readConfig().map((s) => [s.name, s]));
  for (const [name, st] of running) {
    const w = wanted.get(name);
    if (!w || JSON.stringify(w) !== JSON.stringify(st.spec)) {
      log(`stopping ${name}`);
      stop(st);
      running.delete(name);
    }
  }
  for (const [name, spec] of wanted) {
    if (running.has(name)) continue;
    log(`starting ${name}: ${spec.cmd}`);
    const st = { spec, restarts: 0, stopped: false };
    running.set(name, st);
    startProc(st);
    if (spec.public) startTunnel(st);
  }
}

async function tick() {
  reconcile();
  for (const st of running.values()) st.healthy = await health(st);
  writeStatus();
}

process.on("SIGTERM", () => {
  for (const st of running.values()) stop(st);
  process.exit(0);
});

await tick();
setInterval(() => { tick().catch((e) => log(`tick failed: ${e.message}`)); }, 15_000);
