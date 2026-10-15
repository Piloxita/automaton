#!/usr/bin/env python3
"""Host helper for the Hub's Automaton tab.

The Hub runs sandboxed (read-only home, NoNewPrivileges), where rootless
podman cannot work. This helper runs unsandboxed as the creator and is the
only thing that talks to podman/systemd for the Hub:

- every 10 s it writes ~/.local/state/automaton/status.json with the
  container state, the relay unit state and the agent volume's mountpoint;
- it watches ~/.local/state/automaton/control/ for request-<id>.json files
  ({"action": "start"|"stop"|"restart"}), runs only those three actions and
  writes result-<id>.json ({"ok", "message"}).
"""
import json
import os
import re
import subprocess
import time
from pathlib import Path

STATE = Path.home() / ".local/state/automaton"
CONTROL = STATE / "control"
STATUS = STATE / "status.json"
POD = Path.home() / "Projects/automaton/deploy/container/automaton-pod"
CONTAINER = "automaton"
STATUS_EVERY = 10.0
ID_RE = re.compile(r"^request-([A-Za-z0-9_-]{1,64})\.json$")


def run(*cmd, timeout=10):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, str(e)


def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj))
    os.replace(tmp, path)


def inspect() -> dict | None:
    rc, out = run("podman", "inspect", "--type", "container", CONTAINER)
    if rc != 0:
        return None
    try:
        d = json.loads(out)[0]
    except (ValueError, IndexError, KeyError):
        return None
    st = d.get("State") or {}
    return {"Status": st.get("Status"), "Running": bool(st.get("Running")), "StartedAt": st.get("StartedAt"),
            "RestartCount": d.get("RestartCount"), "ImageName": d.get("ImageName")}


def status() -> dict:
    rc_relay, _ = run("systemctl", "--user", "is-active", "automaton-relay")
    rc_vol, vol = run("podman", "volume", "inspect", "automaton-home", "--format", "{{.Mountpoint}}")
    return {"ts": time.time(), "container": inspect(), "relay_active": rc_relay == 0,
            "volume_home": vol if rc_vol == 0 and vol.startswith("/") else None}


def act(action: str) -> dict:
    if action == "start":
        c = inspect()
        if c is not None and not c["Running"]:
            rc, out = run("podman", "start", CONTAINER, timeout=60)
        else:
            rc, out = run(str(POD), "start", timeout=60)
    elif action == "stop":
        rc, out = run("podman", "stop", "-t", "15", CONTAINER, timeout=60)
    elif action == "restart":
        rc, out = run("podman", "restart", "-t", "15", CONTAINER, timeout=60)
    else:
        return {"ok": False, "message": "unknown action"}
    return {"ok": rc == 0, "message": out[-2000:] or (f"{action} done" if rc == 0 else f"{action} failed ({rc})")}


def main() -> None:
    CONTROL.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    os.chmod(CONTROL, 0o700)
    last = 0.0
    while True:
        for req in sorted(CONTROL.glob("request-*.json")):
            m = ID_RE.match(req.name)
            try:
                action = json.loads(req.read_text()).get("action") if m else None
            except (OSError, ValueError, AttributeError):
                action = None
            req.unlink(missing_ok=True)
            if m:
                write_json(CONTROL / f"result-{m.group(1)}.json", act(action) if action in ("start", "stop", "restart")
                           else {"ok": False, "message": "action must be start, stop or restart"})
                last = 0.0
        for old in CONTROL.glob("result-*.json"):
            if time.time() - old.stat().st_mtime > 600:
                old.unlink(missing_ok=True)
        if time.time() - last >= STATUS_EVERY:
            write_json(STATUS, status())
            last = time.time()
        time.sleep(1)


if __name__ == "__main__":
    main()
