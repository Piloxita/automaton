# Contained automaton

The whole runtime runs in a rootless podman container, so the agent may edit
and rebuild its own code (`AUTOMATON_CONTAINED=1` relaxes the protected-file
list to: constitution, config, wallet, soul, dist/, node_modules/, .git/).
Code it writes runs in-process, so the real limits are:

- the container: own network namespace (pasta, no host localhost), no host
  files, memory/CPU/pid limits, no extra capabilities;
- the wallet balance: fund it in small amounts. The SpendGuard caps still
  apply but self-modified code can bypass them.

Inside the container set `"localExecMode": "unsafe-host"` in
/root/.automaton/automaton.json (the container is the sandbox; bwrap does not
nest under rootless podman).

    deploy/container/automaton-pod build   # image from this checkout
    deploy/container/automaton-pod setup   # wizard: wallet, name, genesis prompt
    deploy/container/automaton-pod wallet  # address to fund (USDC on Base)
    deploy/container/automaton-pod start | logs | status | stop

Applying its own changes: edit_own_file rebuilds; the agent then exits the
runtime (`pkill -f "dist/index.js --run"`) and the supervisor starts the new
build. Three crashes within 2 minutes roll back to the last build that ran
for 10 minutes (git tag `last-good`).

## Self-hosted mode (no Conway dependency)

Set `"hostingMode": "selfhosted"` in `deploy/container/instance/params.json`
(see the checked-in example) to run with **no Conway dependency at all**:
no Conway API key, no Conway sandboxes, no Conway credits, no social relay.
Instead:

- **Inference** is paid from a capped OpenRouter (or any OpenAI-compatible)
  API key, configured via `params.openaiCompatible`:
  `{ "baseUrl": "https://openrouter.ai/api", "apiKeyEnv": "OPENROUTER_API_KEY",
  "models": [...] }`. The key itself is never written to params.json or
  automaton.json — it is read from the environment variable named by
  `apiKeyEnv` at runtime. Put it in
  `~/.config/automaton-creator/openrouter.env` as `OPENROUTER_API_KEY=sk-...`;
  `automaton-pod` passes it through with `--env-file` automatically when that
  file exists.
- **Survival** is tracked by the agent's own on-chain USDC balance (Base)
  instead of a Conway credits balance — fund the wallet address printed by
  `automaton-pod wallet` directly.
- **Child replication, Conway sandboxes, and Conway's domain/registry tools
  are hidden** — self-hosted mode delegates work to local in-process workers
  instead (`create_goal` still works; `spawn_child` does not).
- **expose_port / remove_port** use Cloudflare quick tunnels
  (`cloudflared tunnel --url ...`, bundled in the image) instead of Conway's
  sandbox port-forwarding.

Headless setup then run normally:

    deploy/container/automaton-pod build
    deploy/container/automaton-pod setup-headless
    deploy/container/automaton-pod start

Conway-mode code paths are untouched — this is an additive switch, not a fork.
