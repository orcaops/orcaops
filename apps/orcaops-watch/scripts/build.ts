#!/usr/bin/env bun
// Bundles the Bun/OpenTUI UI and Node data sidecar into dist/** so Turbo's
// configured build outputs cache both runtime entry points.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });

// External in EVERY bundle, the UI one included, where they would otherwise
// arrive transitively through @orcaops/core and review-core / review-engine.
const PROPRIETARY = ['@orcaops/protocol', '@orcaops/sdk', '@orcaops/diff-fingerprint'];

const UI_EXTERNAL = ['@opentui/core', '@opentui/react', 'react', ...PROPRIETARY];
const SIDECAR_EXTERNAL = ['better-sqlite3', '@napi-rs/keyring', ...PROPRIETARY];

const ui = await Bun.build({
  entrypoints: [path.join(root, 'src', 'main.tsx')],
  outdir: dist,
  target: 'bun',
  format: 'esm',
  naming: 'main.js',
  // Keep the OpenTUI packages external: @opentui/core loads a native addon
  // (@opentui/core-<platform>) via a runtime require that only resolves from the
  // package's own node_modules, not from a bundle in dist/. react stays external
  // too so the app and @opentui/react share one React instance at runtime.
  external: UI_EXTERNAL,
});

if (!ui.success) {
  for (const log of ui.logs) console.error(log);
  process.exit(1);
}
chmodSync(path.join(dist, 'main.js'), 0o755);
console.log('built dist/main.js');

// target=node so the native better-sqlite3 addon works. The unpublished
// @orcaops/* workspace packages are INLINED: with no registry identity, a
// published watch tarball could never resolve them at runtime.
const sidecar = await Bun.build({
  entrypoints: [path.join(root, 'src', 'data', 'sidecar.ts')],
  outdir: dist,
  target: 'node',
  format: 'esm',
  naming: 'sidecar.js',
  external: SIDECAR_EXTERNAL,
});

if (!sidecar.success) {
  for (const log of sidecar.logs) console.error(log);
  process.exit(1);
}
console.log('built dist/sidecar.js');

// Bun.build echoes no config and exposes no module graph, so the licence gate
// verifies this declaration instead. Written by the build so it cannot drift.
writeFileSync(
  path.join(dist, '.build-externals.json'),
  JSON.stringify({ external: [...new Set([...UI_EXTERNAL, ...SIDECAR_EXTERNAL])] }, null, 2) + '\n'
);
