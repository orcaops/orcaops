import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal API surface for `@orcaops/evaluator-pack`. The package is
 * primarily content-only (the `packs/` subtree); these helpers let
 * external code enumerate + locate first-party packs without
 * hand-coding paths.
 *
 * The resolver in @orcaops/evaluator-runner depends on this surface
 * as a documented contract. `eval add-pack @orcaops/evaluator-pack <id>`
 * also uses `getPack(id)` to validate the requested pack exists
 * before writing the config entry.
 */

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export interface PackManifestRef {
  /** Pack id (e.g., `core`, `js`, `demo`). */
  id: string;
  /**
   * Absolute filesystem path to the pack root. Resolves to
   * `dist/packs/<id>/` when the package is built (the published
   * shape) and falls back to `packs/<id>/` in-workspace before a
   * build — same dist-or-source preference as the runner's resolver.
   */
  pack_root: string;
}

/**
 * Enumerate every first-party pack the package ships. Returns refs
 * for any directory under `packs/` (or `dist/packs/`) that exists.
 * Sorted alphabetically by id for deterministic output.
 */
export function listPacks(): PackManifestRef[] {
  const dirs = packsParentDirs();
  const ids = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  return [...ids]
    .sort()
    .map((id) => {
      const ref = locate(id);
      return ref;
    })
    .filter((ref): ref is PackManifestRef => ref !== null);
}

/**
 * Resolve a single pack id to its on-disk location. Returns `null`
 * when the pack doesn't exist under either the dist or source tree.
 */
export function getPack(id: string): PackManifestRef | null {
  return locate(id);
}

function locate(id: string): PackManifestRef | null {
  for (const dir of packsParentDirs()) {
    const candidate = path.join(dir, id);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return { id, pack_root: candidate };
    }
  }
  return null;
}

/**
 * Directory order matters — dist/packs/ wins when both exist (the
 * published artifact's shape is the canonical one). Workspace
 * fallback to packs/ keeps in-repo development working before a
 * build.
 */
function packsParentDirs(): readonly string[] {
  return [path.join(PACKAGE_ROOT, 'dist', 'packs'), path.join(PACKAGE_ROOT, 'packs')];
}
