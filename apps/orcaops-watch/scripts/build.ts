#!/usr/bin/env bun
// Bundles the Bun/OpenTUI UI and Node data sidecar into dist/** so Turbo's
// configured build outputs cache both runtime entry points.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { embeddedAddonFindings } from '../../../scripts/lib/bundle-scan.mjs';

const root = path.resolve(import.meta.dir, '..');
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });

// External in EVERY bundle, the UI one included, where they would otherwise
// arrive transitively through @orcaops/core and review-core / review-engine.
const PROPRIETARY = ['@orcaops/protocol', '@orcaops/sdk', '@orcaops/diff-fingerprint'];

// Native addons resolve their binary relative to the package they were
// installed into. Bundling one inlines the build machine's absolute path
// (better-sqlite3's binding.js closes over `__dirname`), which resolves
// nowhere on an installed copy — so they stay external in EVERY bundle. The UI
// must never load better-sqlite3 anyway; the sidecar exists for that, and
// storage's loader is lazy, so an external here is never required at run time.
//
// Externalizing one it cannot resolve is worse than bundling it: the require
// throws at run time and callers that probe for an optional addon (the keyring
// store answers "unavailable") swallow it, so the capability disappears in
// silence. Each entry must therefore be a declared dependency of THIS app —
// a transitive copy under another package's node_modules is not reachable from
// dist/ under pnpm's isolated layout.
const NATIVE = ['better-sqlite3', '@napi-rs/keyring'];

const UI_EXTERNAL = ['@opentui/core', '@opentui/react', 'react', ...NATIVE, ...PROPRIETARY];
const SIDECAR_EXTERNAL = [...NATIVE, ...PROPRIETARY];

const requireFromDist = createRequire(path.join(dist, 'main.js'));
for (const addon of NATIVE) {
  try {
    requireFromDist.resolve(addon);
  } catch {
    console.error(
      `[build] ${addon} is declared external but does not resolve from dist/ — ` +
        `add it to apps/orcaops-watch/package.json (optionalDependencies) at the range ` +
        `the owning package uses, or drop it from NATIVE`
    );
    process.exit(1);
  }
}
console.log(`native externals resolve from dist/: ${NATIVE.join(', ')}`);

const ui = await Bun.build({
  entrypoints: [path.join(root, 'src', 'entry.ts')],
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

// The sidecar is @orcaops/watch-data's built entry, bundled here for the dev
// and test paths (the CLI ships its own copy). target=node so the native
// better-sqlite3 addon works; the @orcaops/* workspace packages are INLINED
// because nothing installs them beside dist/.
const sidecar = await Bun.build({
  entrypoints: [fileURLToPath(import.meta.resolve('@orcaops/watch-data/sidecar'))],
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

// A bundle that quotes this checkout's path resolves nowhere once installed,
// and a bundled addon loader leaves a recognizable shape even when the path
// differs. This catches a native addon that slipped back out of NATIVE; it does
// not prove the bundle is correctly packaged. See scripts/lib/bundle-scan.mjs.
const checkout = path.resolve(root, '..', '..');
for (const bundle of ['main.js', 'sidecar.js']) {
  const findings = embeddedAddonFindings(readFileSync(path.join(dist, bundle), 'latin1'), {
    checkout,
  });
  if (findings.length > 0) {
    for (const finding of findings) console.error(`[build] ${bundle} ${finding}`);
    process.exit(1);
  }
}
console.log('bundles embed no build checkout path and no inlined native addon');

// Bun.build echoes no config and exposes no module graph, so the licence gate
// verifies this declaration instead. Written by the build so it cannot drift.
writeFileSync(
  path.join(dist, '.build-externals.json'),
  JSON.stringify({ external: [...new Set([...UI_EXTERNAL, ...SIDECAR_EXTERNAL])] }, null, 2) + '\n'
);
