import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the built Node sidecar (dist/sidecar.js).
 *
 * The launcher hands a compiled UI its sidecar through `ORCAOPS_WATCH_SIDECAR`:
 * inside a single-file executable `import.meta.url` is a `$bunfs` path with
 * nothing beside it, so the on-disk candidates below only serve the bundled
 * dev build (dist/main.js -> dist/sidecar.js) and a raw `bun src/entry.ts` run
 * after a prior build.
 *
 * The sidecar is MANDATORY — there is no sidecar-less data path. Both
 * transports (the warm stream source and the one-shot poll source) spawn
 * `node dist/sidecar.js`, because better-sqlite3's native addon must load
 * under Node, off the Bun UI process. When this returns null the data
 * sources throw `sidecarMissingError()` and the TUI surfaces it gracefully
 * as a per-panel "data unavailable" line.
 */
export function resolveSidecar(env: NodeJS.ProcessEnv = process.env): string | null {
  const handed = env.ORCAOPS_WATCH_SIDECAR;
  if (handed !== undefined && handed !== '' && existsSync(handed)) return handed;
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
 * state has three audiences with different remediations — a dev running raw
 * from source (build it), a compiled UI launched by hand (it needs the
 * launcher's hand-off), and a broken release install (reinstall) — so the
 * message names all three instead of guessing.
 */
export function sidecarMissingError(): Error {
  return new Error(
    'watch sidecar (dist/sidecar.js) is not built — running from source? ' +
      'run `pnpm build` at the repo root (or `bun scripts/build.ts` in apps/orcaops-watch); ' +
      'launched the compiled UI directly? start it through `orcaops watch`, which sets ORCAOPS_WATCH_SIDECAR; ' +
      'installed via a release? reinstall/upgrade the orcaops watch app'
  );
}
