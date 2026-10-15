#!/usr/bin/env python3
"""Daily digest of the automaton for the owner's Telegram "Automaton" topic.

Deterministic (no LLM): reads the agent's state.db, workspace (kb, ledger,
services-status.json), the host helper's status file and the relay log, then
posts plain text through the master bot's topic-post spool (pmb.botchat).
Runs from the master bot's venv (so `pmb` imports), daily at 21:00, plus a
shorter-window morning standup at 10:00 (`--standup`: covers the night since
the evening digest and leaves the evening wallet baseline alone).

  automaton-digest.py [--standup] [--dry-run]
"""
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
VOL = HOME / ".local/share/containers/storage/volumes/automaton-home/_data"
WS = VOL / "workspace"
KB = WS / "kb"
HOST_STATUS = HOME / ".local/state/automaton/status.json"
RELAY_LOG = HOME / ".local/state/automaton-relay/log.jsonl"
STATE = HOME / ".local/state/automaton/digest-state.json"
MAX_LINES = 8


def db():
    return sqlite3.connect(f"file:{VOL / 'state.db'}?mode=ro", uri=True, timeout=5)


def kv(con, key):
    r = con.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return r[0] if r else None


def money(c):
    return f"${c / 100:,.2f}"


def main(dry: bool, standup: bool = False) -> int:
    now = time.time()
    since = now - (13 if standup else 24) * 3600
    win = "overnight" if standup else "in 24 h"
    since_iso = datetime.fromtimestamp(since, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    lines, needs = [], []
    prev = {}
    try:
        prev = json.loads(STATE.read_text())
    except (OSError, ValueError):
        pass

    # container and runtime
    try:
        st = json.loads(HOST_STATUS.read_text())
        c = st.get("container") or {}
        running = bool(c.get("Running"))
        if now - float(st.get("ts", 0)) > 120:
            needs.append("Host helper (automaton-hostd) is not reporting.")
    except (OSError, ValueError):
        running = False
        needs.append("Host helper (automaton-hostd) is not reporting.")
    if not running:
        needs.append("The agent container is NOT running.")

    usdc = None
    try:
        con = db()
        state = kv(con, "agent_state") or "?"
        bal = json.loads(kv(con, "last_known_balance") or "{}")
        usdc = float(bal.get("usdcBalance") or 0)
        turns = con.execute("SELECT COUNT(*) FROM turns WHERE timestamp >= ?", (since_iso,)).fetchone()[0]
        last = con.execute("SELECT MAX(timestamp) FROM turns").fetchone()[0]
        spend = con.execute("SELECT COALESCE(SUM(cost_cents),0) FROM inference_costs WHERE created_at >= ?",
                            (since_iso.replace("T", " "),)).fetchone()[0]
        revenue = con.execute("SELECT COALESCE(SUM(actual_revenue_cents),0) FROM goals").fetchone()[0]
        # The heartbeat ticks every minute inside the runtime, asleep or awake; if it is
        # silent the runtime is down even when the container says "running".
        beat = con.execute("SELECT MAX(started_at) FROM heartbeat_history").fetchone()[0]
        sleep_until = kv(con, "sleep_until")
        con.close()
        if running and (not beat or now - datetime.fromisoformat(beat.replace("Z", "+00:00")).timestamp() > 1800):
            needs.append(f"Agent runtime looks down: no heartbeat since {str(beat)[:16].replace('T', ' ')} UTC (container up).")
        if state == "sleeping" and sleep_until:
            state = f"sleeping until {sleep_until[11:16]} UTC"
        lines.append(f"State: {state} · {turns} turns {win} · last turn {str(last)[:16].replace('T', ' ')} UTC")
        if turns == 0:
            needs.append("No agent turns " + ("overnight." if standup else "in the last 24 hours."))
        delta = ""
        if "usdc" in prev:
            d = usdc - float(prev["usdc"])
            delta = f" ({'+' if d >= 0 else ''}{d:.2f} {'since last night' if standup else 'since yesterday'})"
        lines.append(f"Wallet: {usdc:.2f} USDC{delta} · recorded revenue {money(revenue)} · thinking {money(spend)} ({'overnight' if standup else '24 h'}, notional)")
    except (OSError, sqlite3.Error, ValueError) as e:
        needs.append(f"Could not read the agent database: {e}")

    # relay
    calls = limited = errors = 0
    try:
        for raw in RELAY_LOG.read_text().splitlines()[-3000:]:
            try:
                e = json.loads(raw)
                ts = datetime.fromisoformat(e["ts"]).timestamp()
            except (ValueError, KeyError):
                continue
            if ts < since:
                continue
            calls += 1
            limited += e.get("status") == "limited"
            errors += e.get("status") in ("error", "timeout")
    except OSError:
        pass
    lines.append(f"Relay: {calls} calls {win}" + (f" · {limited} limit hits" if limited else "") + (f" · {errors} errors" if errors else ""))
    if limited:
        needs.append(f"The second Claude account hit its usage limit {limited}x " + ("overnight." if standup else "today."))

    # services
    try:
        svc = json.loads((WS / "services-status.json").read_text()).get("services", [])
    except (OSError, ValueError):
        svc = []
    if svc:
        lines.append("Services:")
        for s in svc:
            mark = "up" if s.get("running") and s.get("healthy") is not False else "DOWN"
            lines.append(f"  · {s.get('name')}: {mark}, {s.get('restarts', 0)} restarts" + (f", {s['url']}" if s.get("url") else ""))
            if mark == "DOWN":
                needs.append(f"Service {s.get('name')} is down.")

    # experiments (kb/services notes)
    exps = []
    for p in sorted((KB / "services").glob("*.md")) if (KB / "services").is_dir() else []:
        m = re.search(r"^[\W_]*status[\W_]*:[\W_]*([A-Za-z][\w -]{0,30})", p.read_text(errors="replace"), re.I | re.M)
        status = m.group(1).strip().lower() if m else "?"
        exps.append(f"{p.stem} ({status})")
    if exps:
        lines.append("Experiments: " + ", ".join(exps))

    # today's journal and recently changed notes
    today = datetime.now(timezone.utc).date()
    jl = []
    for d in (today - timedelta(days=1), today):
        f = KB / "journal" / f"{d.isoformat()}.md"
        if f.is_file():
            jl += [l.strip() for l in f.read_text(errors="replace").splitlines() if l.strip().startswith(("-", "*"))]
    if jl:
        lines.append("Journal:")
        lines += [f"  {l[:220]}" for l in jl[-MAX_LINES:]]
    changed = [p.relative_to(KB).as_posix() for p in KB.rglob("*.md")
               if p.stat().st_mtime >= since and "journal/" not in p.relative_to(KB).as_posix() and p.name != "README.md"] if KB.is_dir() else []
    if changed:
        lines.append("Notes updated: " + ", ".join(sorted(changed)[:10]))

    # the agent's own asks
    ask = KB / "needs-creator.md"
    if ask.is_file() and ask.read_text(errors="replace").strip():
        needs.append("The agent asks: " + ask.read_text(errors="replace").strip()[:600])

    title = "☀️ Automaton standup" if standup else "🤖 Automaton daily"
    head = f"{title} · {datetime.now().strftime('%a %d %b')}"
    tail = ["", "⚠️ Needs you:"] + [f"  · {n}" for n in needs] if needs else ["", "✅ No action needed."]
    text = "\n".join([head, ""] + lines + tail + ["", "Hub: " + os.environ.get("AUTOMATON_HUB_URL", "http://127.0.0.1:8765/#/automaton")])

    if dry:
        print(text)
        return 0
    sys.path.insert(0, str(HOME / "Projects/piloxita-master-bot"))
    from pmb import botchat
    botchat.post("master", "automaton", text)
    if usdc is not None and not standup:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps({"usdc": usdc, "ts": now}))
    print("posted")
    return 0


if __name__ == "__main__":
    sys.exit(main("--dry-run" in sys.argv, "--standup" in sys.argv))
