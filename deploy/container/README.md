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
