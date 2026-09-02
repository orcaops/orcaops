#!/usr/bin/env node
// Node shim that execs the Bun-built OpenTUI UI. `orcaops watch` (and a direct
// `orcaops-watch` call) resolve this bin by name on PATH; it hands off to Bun,
// the only runtime the OpenTUI UI runs under. The Node entry keeps the CLI
// delegation runtime-agnostic — the stub spawns it like any other bin.
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function resolveBun() {
  if (process.env.ORCAOPS_WATCH_BUN) return process.env.ORCAOPS_WATCH_BUN;
  return 'bun'; // from PATH (dev machine / CI setup-bun / global install)
}

// The `review …` verbs are Node sidecar subcommands (they need better-sqlite3),
// not the Bun OpenTUI UI — route them straight to the built sidecar.
const forwarded = process.argv.slice(2);
if (forwarded[0] === 'review') {
  const node = process.env.ORCAOPS_WATCH_NODE || 'node';
  const sidecar = path.join(__dirname, '..', 'dist', 'sidecar.js');
  const r = spawnSync(node, [sidecar, ...forwarded], { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 1 : r.status);
}

const entry = path.join(__dirname, '..', 'dist', 'main.js');
const result = spawnSync(resolveBun(), [entry, ...forwarded], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error && result.error.code === 'ENOENT') {
  process.stderr.write(
    "orcaops-watch: could not find the 'bun' runtime.\n" +
      'Install Bun (https://bun.sh) or set ORCAOPS_WATCH_BUN to its path.\n'
  );
  process.exit(127);
}
process.exit(result.status === null ? 1 : result.status);
