#!/usr/bin/env bash
# Supervisor inside the container. The agent applies its own code changes by
# rebuilding (edit_own_file does) and then exiting the runtime, e.g.
# `pkill -f "dist/index.js --run"`; this loop starts the new build.
# If a new build crashes within 2 minutes three times running, roll back to
# the last build that stayed up for 10 minutes.
set -u
cd /app
pid=""
# The agent's own long-running services (workspace/services.json) and their tunnels.
( while true; do node /app/deploy/container/services-runner.mjs; echo "[supervisor] services runner exited, restarting"; sleep 5; done ) &
svc=$!
trap 'echo "[supervisor] stopping"; kill -TERM "$svc" 2>/dev/null; pkill -TERM -f services-runner.mjs 2>/dev/null; [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; exit 0' TERM INT
fast_crashes=0
while true; do
  start=$(date +%s)
  node dist/index.js --run &
  pid=$!
  ( sleep 600; kill -0 "$pid" 2>/dev/null && git tag -f last-good HEAD >/dev/null 2>&1 ) &
  wait "$pid"; rc=$?
  ran=$(( $(date +%s) - start ))
  echo "[supervisor] runtime exited rc=$rc after ${ran}s"
  if [ "$ran" -lt 120 ]; then fast_crashes=$((fast_crashes + 1)); else fast_crashes=0; fi
  if [ "$fast_crashes" -ge 3 ] && git rev-parse -q --verify last-good >/dev/null; then
    echo "[supervisor] 3 fast crashes: rolling back to last-good"
    git stash push -u -m "auto-rollback $(date -u +%FT%TZ)" >/dev/null 2>&1 || true
    git reset --hard last-good && pnpm build || echo "[supervisor] rollback build failed"
    fast_crashes=0
  fi
  sleep 5
done
