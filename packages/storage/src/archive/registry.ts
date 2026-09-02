import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ensureDir0700 } from './paths.js';
import { atomicWriteFile } from '../artifacts/atomic-write.js';

/**
 * The self-healing project registry — `<dataRoot>/projects.json`.
 *
 * Everything in here is a **re-association HINT verified on access**
 * (zoxide-style), never a key: paths move, remotes churn, multiple root
 * commits exist. The archive itself is keyed ONLY by the minted project id;
 * losing or corrupting this file never touches authoritative archive
 * contents, but it costs display names, re-association suggestions, and
 * Watch's only cross-project review-target candidate paths until each
 * project is visited and re-registered — so reads are tolerant
 * (missing/corrupt → empty) and writes happen only when a hint actually
 * changed.
 */

export const REGISTRY_SCHEMA_VERSION = 1;

/** Cap per hint list — most-recent-first, oldest dropped. */
const HINT_LIST_CAP = 8;

export const RegistryProjectSchema = z.object({
  display_name: z.string().default(''),
  last_seen_paths: z.array(z.string()).default([]),
  remotes: z.array(z.string()).default([]),
  root_commit_shas: z.array(z.string()).default([]),
  /** Last time a hint CHANGED (not last access — reads never write). */
  last_seen_at: z.string().default(''),
});
export type RegistryProject = z.infer<typeof RegistryProjectSchema>;

export const RegistrySchema = z.object({
  schema_version: z.literal(REGISTRY_SCHEMA_VERSION),
  projects: z.record(z.string(), RegistryProjectSchema).default({}),
});
export type Registry = z.infer<typeof RegistrySchema>;

export function emptyRegistry(): Registry {
  return { schema_version: REGISTRY_SCHEMA_VERSION, projects: {} };
}

/**
 * Load the registry, tolerating a missing, unparseable, or wrong-shape
 * file — hints only, so degradation is silent and total.
 */
export async function loadRegistry(registryFilePath: string): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(registryFilePath, 'utf8');
  } catch {
    return emptyRegistry();
  }
  try {
    const parsed = RegistrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyRegistry();
  } catch {
    return emptyRegistry();
  }
}

export interface ProjectHintsInput {
  displayName?: string;
  path?: string;
  remote?: string | null;
  rootCommitShas?: string[];
  /** ISO timestamp stamped as `last_seen_at` when a hint changes. */
  ts: string;
}

export interface TouchProjectResult {
  registry: Registry;
  /** True when a hint changed and the registry should be persisted. */
  changed: boolean;
}

/**
 * Merge fresh hints for a project (pure). Returns `changed: false` when
 * every hint was already present — the caller then skips the write, so a
 * steady-state invocation costs one small read and zero writes.
 */
export function touchProject(
  registry: Registry,
  projectId: string,
  hints: ProjectHintsInput
): TouchProjectResult {
  const prior = registry.projects[projectId];
  const next: RegistryProject = prior
    ? {
        ...prior,
        last_seen_paths: [...prior.last_seen_paths],
        remotes: [...prior.remotes],
        root_commit_shas: [...prior.root_commit_shas],
      }
    : RegistryProjectSchema.parse({});

  let changed = prior === undefined;
  if (hints.displayName && next.display_name !== hints.displayName) {
    next.display_name = hints.displayName;
    changed = true;
  }
  if (hints.path) changed = pushHint(next.last_seen_paths, hints.path) || changed;
  if (hints.remote) changed = pushHint(next.remotes, hints.remote) || changed;
  for (const sha of hints.rootCommitShas ?? []) {
    changed = pushHint(next.root_commit_shas, sha) || changed;
  }
  if (!changed) return { registry, changed: false };

  next.last_seen_at = hints.ts;
  return {
    registry: {
      schema_version: REGISTRY_SCHEMA_VERSION,
      projects: { ...registry.projects, [projectId]: next },
    },
    changed: true,
  };
}

/** Persist atomically (temp + rename) with a 0700 parent. */
export async function saveRegistry(registryFilePath: string, registry: Registry): Promise<void> {
  await ensureDir0700(path.dirname(registryFilePath));
  await atomicWriteFile(registryFilePath, JSON.stringify(registry, null, 2) + '\n');
}

/** Most-recent-first dedupe with a cap; returns true when the list changed. */
function pushHint(list: string[], value: string): boolean {
  if (list[0] === value) return false;
  const existing = list.indexOf(value);
  if (existing !== -1) list.splice(existing, 1);
  list.unshift(value);
  if (list.length > HINT_LIST_CAP) list.length = HINT_LIST_CAP;
  return true;
}
