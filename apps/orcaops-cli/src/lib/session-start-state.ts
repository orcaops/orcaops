import { access } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, Repo } from '@orcaops/core';
import { ArtifactStore } from '@orcaops/storage';

import { deriveLabel, loadInFlightOnBranch } from './active-artifact.js';
import { getInvocationCwd } from './invocation-context.js';
import { discoverGitRoot, resolveExplicitOverride } from './resolve-root.js';

/**
 * Idle threshold after which an open checkpoint reads as "left over from a
 * previous session". Shared with doctor's `open-checkpoint-stale` check so
 * the session-start hook guidance and doctor can never disagree on what
 * "stale" means.
 */
export const STALE_CHECKPOINT_HOURS = 24;

export interface SessionStartOpenCheckpoint {
  n: number;
  openedAt: string;
  idleHours: number | null;
}

export interface SessionStartArtifact {
  id: string;
  label: string;
  state: string;
  checkpointCount: number;
  openCheckpoints: SessionStartOpenCheckpoint[];
}

export type SessionStartState =
  | { kind: 'uninitialized' }
  /**
   * `session_hooks.payload: 'static'` (the default): the hook emits a fixed
   * prefix-aware nudge with ZERO state reads — no git call, no SQLite open.
   */
  | { kind: 'static'; prefix: string }
  | {
      kind: 'ready';
      branch: string;
      prefix: string;
      cacheStatus: 'available' | 'missing';
      inFlight: SessionStartArtifact[];
    };

export async function resolveSessionStartRoot(cwd?: string): Promise<string | null> {
  const base = path.resolve(cwd ?? getInvocationCwd());
  return (await resolveExplicitOverride(base)) ?? (await discoverGitRoot(base));
}

/**
 * Read-only capture state for `orcaops hook session-start`. The contract is
 * load-bearing for a command that runs at EVERY agent session start:
 *
 *  - **Never throws** — failures degrade to `uninitialized` silence, except
 *    branch resolution in an initialized repo, which retains the static nudge.
 *  - **Fast** — no LLM, no network, no archive wiring. Deliberately NOT
 *    `buildContext` (which wires the archive mirror and maps errors for
 *    interactive commands).
 *  - **Zero writes on the fresh-repo path** — when the SQLite cache file does
 *    not exist yet, report that cached state is unavailable WITHOUT
 *    constructing ArtifactStore, whose constructor would create the cache
 *    file. A read-only nudge must not materialize state in a repo the user
 *    hasn't captured in.
 *    The claim is deliberately NARROW: on already-materialized state the
 *    canonical loaders are used as-is (accepted over raw reads, which would
 *    silently diverge from them), and any writes they perform are idempotent
 *    and confined to `.orcaops/`.
 */
export async function readSessionStartState(
  cwd?: string,
  resolvedRoot?: string | null
): Promise<SessionStartState> {
  try {
    const repoRoot = resolvedRoot === undefined ? await resolveSessionStartRoot(cwd) : resolvedRoot;
    if (!repoRoot) return { kind: 'uninitialized' };
    try {
      await access(path.join(repoRoot, '.orcaops'));
    } catch {
      return { kind: 'uninitialized' };
    }
    const config = await loadConfig(repoRoot);
    // EMISSION gate: `session_hooks.enabled` is the per-repo switch. With
    // machine-level registration (user-level hooks fire in every repo), this
    // is what keeps a repo that never opted in silent — and it also silences
    // the transient "entries on disk, enabled just flipped off" window
    // immediately instead of waiting for the next update's strip.
    if (!config.session_hooks.enabled) return { kind: 'uninitialized' };
    const prefix = config.naming.prefix;

    // The payload mode is read fresh HERE, each session start — never baked
    // into the installed settings entries — so switching modes
    // (`orcaops update --session-hook-payload …`) takes effect on the next
    // session with no reinstall and no restart. Static short-circuits before
    // any state read: it works in a commitless repo and shrugs off a corrupt
    // cache, which is exactly its reduced failure surface.
    if (config.session_hooks.payload === 'static') {
      return { kind: 'static', prefix };
    }

    let branch: string;
    try {
      branch = await new Repo(repoRoot).getCurrentBranch();
    } catch {
      return { kind: 'static', prefix };
    }
    if (branch === 'HEAD') branch = 'detached HEAD';

    const cacheDb = path.join(repoRoot, config.cache.path);
    try {
      await access(cacheDb);
    } catch {
      return { kind: 'ready', branch, prefix, cacheStatus: 'missing', inFlight: [] };
    }

    // A store that cannot open must not silence the hook: degrade to the
    // static nudge, the same visible fallback branch resolution uses. This
    // arm is reachable in a healthy repo — the ArtifactStore constructor
    // dlopens better-sqlite3, and a hook environment whose `node` ABI
    // differs from the one the addon was built for throws right here.
    let store: ArtifactStore;
    try {
      store = new ArtifactStore({ repoRoot, config, archive: null });
    } catch {
      return { kind: 'static', prefix };
    }
    try {
      const rows = await loadInFlightOnBranch({ store }, branch);
      const nowMs = Date.now();
      const inFlight: SessionStartArtifact[] = rows.map(({ row, json }) => ({
        id: row.id,
        label: deriveLabel(row),
        state: json.state,
        checkpointCount: json.checkpoint_count,
        openCheckpoints: store.store.getOpenCheckpoints(row.id).map((cp) => {
          const openedMs = new Date(cp.opened_at).getTime();
          return {
            n: cp.n,
            openedAt: cp.opened_at,
            idleHours: Number.isFinite(openedMs)
              ? Math.max(0, (nowMs - openedMs) / 3_600_000)
              : null,
          };
        }),
      }));
      return { kind: 'ready', branch, prefix, cacheStatus: 'available', inFlight };
    } catch {
      // Same contract as the constructor guard: a failed read degrades
      // visibly, never to silence.
      return { kind: 'static', prefix };
    } finally {
      store.close();
    }
  } catch {
    return { kind: 'uninitialized' };
  }
}
