#!/usr/bin/env python3
"""OpenAI-compatible chat endpoint backed by the Claude Code CLI (subscription).

Runs on the host as the creator. Listens on a unix socket that is bind-mounted
into the automaton container, so the container never sees a Claude credential
and no TCP port is opened. Every request runs `claude -p` with all built-in
tools disabled, no MCP servers, no user settings/hooks/memory (a dedicated
CLAUDE_CONFIG_DIR), in an empty working directory: the model can only return
text. Tool calls are emulated with a JSON reply protocol and translated back
to OpenAI `tool_calls`; the automaton executes them inside its container.

Limits: one request at a time, RELAY_MAX_CALLS_PER_HOUR (default 60). When
the subscription limit is hit, requests get HTTP 429 and the agent sleeps.

Env:
  RELAY_SOCKET              default $XDG_RUNTIME_DIR/automaton-relay/relay.sock
  CLAUDE_CONFIG_DIR         dedicated config dir for the agent's account
  CLAUDE_CODE_OAUTH_TOKEN   alternative: long-lived token from `claude setup-token`
  RELAY_MAX_CALLS_PER_HOUR  default 60 (the unit sets 120)
  RELAY_TIMEOUT_SECS        default 300
"""
import json
import os
import re
import secrets
import socketserver
import subprocess
import tempfile
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler

RUNTIME = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
SOCKET = os.environ.get("RELAY_SOCKET", os.path.join(RUNTIME, "automaton-relay", "relay.sock"))
MAX_PER_HOUR = int(os.environ.get("RELAY_MAX_CALLS_PER_HOUR", "60"))
TIMEOUT = int(os.environ.get("RELAY_TIMEOUT_SECS", "300"))
STATE = os.path.expanduser("~/.local/state/automaton-relay")
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")
MODEL_ALIASES = {"sonnet": "sonnet", "opus": "opus", "haiku": "haiku"}
MAX_BODY = 8 * 1024 * 1024

lock = threading.Lock()
calls = deque()
limited_until = 0.0

PROTOCOL = """

## Reply protocol (mandatory)
You are the reasoning engine of an autonomous agent runtime. You cannot run tools
yourself; the runtime runs them. Reply with ONE JSON object and nothing else:
{"content": "<your thinking or message, may be empty>",
 "tool_calls": [{"name": "<tool name>", "arguments": {<arguments matching the tool schema>}}]}
Use "tool_calls": [] when no tool is needed. Only call tools listed under
"Available tools". Tool results arrive in later turns as [tool result] blocks.
"""


def log(entry):
    os.makedirs(STATE, exist_ok=True)
    entry["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(os.path.join(STATE, "log.jsonl"), "a") as f:
        f.write(json.dumps(entry) + "\n")


def text_of(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return str(content)


def render(messages, tools):
    system = "\n\n".join(text_of(m.get("content")) for m in messages if m.get("role") == "system")
    lines = []
    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        if role == "tool":
            lines.append(f"[tool result name={m.get('name', '')} id={m.get('tool_call_id', '')}]\n{text_of(m.get('content'))}")
        elif role == "assistant":
            block = f"[assistant]\n{text_of(m.get('content'))}"
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function", {})
                block += f"\n(called tool {fn.get('name')} id={tc.get('id')} with {fn.get('arguments')})"
            lines.append(block)
        else:
            lines.append(f"[{role}]\n{text_of(m.get('content'))}")
    tool_specs = [
        {"name": t["function"]["name"], "description": t["function"].get("description", ""),
         "parameters": t["function"].get("parameters", {})}
        for t in (tools or []) if t.get("type") == "function"
    ]
    prompt = "Available tools:\n" + json.dumps(tool_specs, separators=(",", ":")) + \
        "\n\nConversation so far:\n\n" + "\n\n".join(lines) + \
        "\n\nNow reply with the JSON object described in the reply protocol."
    return system + PROTOCOL, prompt


def parse_reply(text, tool_names):
    candidate = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", candidate, re.S)
    if fence:
        candidate = fence.group(1)
    elif not candidate.startswith("{"):
        start, end = candidate.find("{"), candidate.rfind("}")
        if start != -1 and end > start:
            candidate = candidate[start:end + 1]
    try:
        obj = json.loads(candidate)
    except (ValueError, TypeError):
        return text, []
    content = obj.get("content") or ""
    out = []
    for tc in obj.get("tool_calls") or []:
        name = tc.get("name")
        if name not in tool_names:
            content += f"\n(ignored call to unknown tool {name!r})"
            continue
        args = tc.get("arguments", {})
        out.append({"id": "call_" + secrets.token_hex(8), "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args if isinstance(args, dict) else {})}})
    return content, out


def run_claude(system, prompt, model):
    env = {k: v for k, v in os.environ.items() if not k.startswith("ANTHROPIC_")}
    with tempfile.TemporaryDirectory(prefix="relay-") as cwd:
        argv = [CLAUDE, "-p", "--output-format", "json", "--model", model,
                "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
                "--system-prompt", system]
        return subprocess.run(argv, input=prompt, capture_output=True, text=True,
                              timeout=TIMEOUT, cwd=cwd, env=env)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, msg):
        self.send_json(status, {"error": {"message": msg, "code": status}})

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            return self.send_json(200, {"ok": True, "limited_until": limited_until, "calls_last_hour": len(calls)})
        self.error(404, "not found")

    def do_POST(self):
        global limited_until
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self.error(404, "not found")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.error(413, "body too large or empty")
        try:
            req = json.loads(self.rfile.read(length))
        except ValueError:
            return self.error(400, "invalid json")
        requested = str(req.get("model", "sonnet"))
        model = MODEL_ALIASES.get(requested.split("/")[-1], "sonnet")
        tools = req.get("tools") or []
        tool_names = {t["function"]["name"] for t in tools if t.get("type") == "function"}
        system, prompt = render(req.get("messages") or [], tools)

        with lock:
            now = time.time()
            if now < limited_until:
                return self.error(429, f"subscription usage limit; retry after {int(limited_until - now)}s")
            while calls and now - calls[0] > 3600:
                calls.popleft()
            if len(calls) >= MAX_PER_HOUR:
                return self.error(429, f"relay cap of {MAX_PER_HOUR} calls/hour reached")
            calls.append(now)
            t0 = time.time()
            try:
                p = run_claude(system, prompt, model)
            except subprocess.TimeoutExpired:
                log({"status": "timeout", "model": model})
                return self.error(504, "claude timed out")
            secs = round(time.time() - t0, 1)

        try:
            out = json.loads(p.stdout)
        except ValueError:
            out = {"is_error": True, "result": (p.stderr or p.stdout)[-500:]}
        result = str(out.get("result", ""))
        if out.get("is_error") or p.returncode != 0:
            if re.search(r"limit|resets?", result, re.I):
                limited_until = time.time() + 30 * 60
                log({"status": "limited", "model": model, "secs": secs})
                return self.error(429, "subscription usage limit reached: " + result[:200])
            log({"status": "error", "model": model, "secs": secs, "rc": p.returncode, "detail": result[:200]})
            return self.error(502, "claude failed: " + result[:300])

        content, tool_calls = parse_reply(result, tool_names)
        usage = out.get("usage") or {}
        pin = int(usage.get("input_tokens", 0)) + int(usage.get("cache_read_input_tokens", 0)) + \
            int(usage.get("cache_creation_input_tokens", 0))
        pout = int(usage.get("output_tokens", 0))
        log({"status": "ok", "model": model, "secs": secs, "in": pin, "out": pout, "tool_calls": len(tool_calls)})
        self.send_json(200, {
            "id": "chatcmpl-" + secrets.token_hex(8), "object": "chat.completion",
            "created": int(time.time()), "model": requested,
            "choices": [{"index": 0, "finish_reason": "tool_calls" if tool_calls else "stop",
                         "message": {"role": "assistant", "content": content,
                                     **({"tool_calls": tool_calls} if tool_calls else {})}}],
            "usage": {"prompt_tokens": pin, "completion_tokens": pout, "total_tokens": pin + pout},
        })


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class UnixHandler(Handler):
    # BaseHTTPRequestHandler expects a (host, port) client address.
    def address_string(self):
        return "unix"


def main():
    os.makedirs(os.path.dirname(SOCKET), mode=0o700, exist_ok=True)
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    srv = Server(SOCKET, UnixHandler)
    os.chmod(SOCKET, 0o600)
    print(f"automaton relay on {SOCKET}, cap {MAX_PER_HOUR}/h", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
