#!/usr/bin/env bash
# Linux smoke test for the release CLI tarball. Proves the cross-platform tarball
# installs and runs on a bare Linux host (no libsecret): the bundle loads, the
# native better-sqlite3 prebuild resolves, the bundled+minified evaluator runtime
# executes as a subprocess, and the lazy keyring degrades gracefully.
#
# Usage (from the repo root, after `pnpm release:cli`):
#   docker run --rm \
#     -v "$PWD/dist-release:/rel:ro" \
#     -v "$PWD/scripts/smoke-cli-linux.sh:/smoke.sh:ro" \
#     node:22 bash /smoke.sh
#   # x86_64 from an arm host: add  --platform linux/amd64
set -e

echo "=== node $(node --version) on $(uname -m) (linux) ==="
if ldconfig -p 2>/dev/null | grep -qi libsecret; then echo "(note: libsecret present)"; else echo "(confirmed: no libsecret in image)"; fi

TARBALL=$(ls /rel/orcaops-cli-*.tgz | head -1)
[ -n "$TARBALL" ] || { echo "FAIL: no /rel/orcaops-cli-*.tgz found"; exit 1; }
echo "--- install $TARBALL ---"
npm i -g "$TARBALL" >/dev/null 2>&1
echo "version: $(orcaops --version)"   # bundle loads (no eager keyring crash) + linux better-sqlite3 prebuild

mkdir -p /tmp/r && cd /tmp/r
git init -q
git -c user.email=t@t.co -c user.name=t commit --allow-empty -qm init
# NO --yes: the installed CLI's built-in trust manifest covers the bundled
# core pack (fingerprints over its covered installed pack-file bytes), so add-pack needs
# no trust prompt and no repo-provided grant. A prompt here would hang and
# fail the smoke — which is the point: built-in trust must carry it.
orcaops init --json >/dev/null && echo "init: OK"
orcaops eval add-pack @orcaops/evaluator-pack core --json >/dev/null && echo "add-pack core (no --yes, manifest-trusted): OK"

printf 'task: |-\n  linux smoke\nlabel: |-\n  linux bundled runtime smoke\nplan_steps:\n  - text: |-\n      verify the bundled minified evaluator runtime executes on linux\n    label: |-\n      verify runtime on linux\ntouched_scope: []\nnon_goals: []\n' > plan.yaml
orcaops capture plan --input plan.yaml > out.json 2>err.txt || { echo "CAPTURE FAILED"; cat err.txt; exit 1; }
completed=$(grep -o '"run_status":"completed"' out.json | wc -l | tr -d ' ')
echo "command-engine evaluators completed: $completed"
[ "$completed" -ge 1 ] || { echo "FAIL: no evaluators ran"; exit 1; }

# Lazy keyring: request the keyring store on a host with no libsecret; it must
# fall through to the file store, NOT crash at native import/load.
out=$(ORCAOPS_CREDENTIAL_STORE=keyring orcaops doctor --json 2>&1 || true)
if echo "$out" | grep -qiE "dlopen|libsecret|cannot find module '@napi|symbol not found|Dynamic require"; then
  echo "FAIL: keyring-requested crashed on bare linux"; echo "$out" | head -5; exit 1
fi
echo "keyring-requested on bare linux: no native crash (graceful fall-through) OK"

echo "=== LINUX SMOKE OK ==="
