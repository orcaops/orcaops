import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the built Node sidecar (dist/sidecar.js). Present when the app is
 * built (bundled main.js -> dist/) or after a dev build; absent when running
 * `bun src/main.tsx` raw from source with no prior build.
 *
 * The sidecar is MANDATORY — there is no sidecar-less data path. Both
 * transports (the warm stream source and the one-shot poll source) spawn
 * `node dist/sidecar.js`, because better-sqlite3's native addon must load
 * under Node, off the Bun UI process. When this returns null the data
 * sources throw `sidecarMissingError()` and the TUI surfaces it gracefully
 * as a per-panel "data unavailable" line.
 */
export function resolveSidecar(): string | null {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(dir, 'sidecar.js'), // bundled: dist/main.js -> dist/sidecar.js
    path.join(dir, '..', '..', 'dist', 'sidecar.js'), // dev: src/data -> dist/sidecar.js
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The one sidecar-missing error every data source throws. The absent-sidecar
 * state has two audiences with different remediations — a dev running raw
 * from source (build it) and a broken release install (reinstall) — so the
 * message names both instead of guessing.
 */
export function sidecarMissingError(): Error {
  return new Error(
    'watch sidecar (dist/sidecar.js) is not built — running from source? ' +
      'run `pnpm build` at the repo root (or `bun scripts/build.ts` in apps/orcaops-watch); ' +
      'installed via a release? reinstall/upgrade the orcaops watch app'
  );
}
