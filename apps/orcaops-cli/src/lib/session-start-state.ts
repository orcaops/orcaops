import path from 'node:path';

import {
  configFromSource,
  probeWorktree,
  Repo,
  resolveConfigSource,
  type WorktreeProbe,
} from '@orcaops/core';
import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { inspectHistoryPath } from '@orcaops/storage/history/authority';
import { projectDatabasePath, readProjectTaskContext } from '@orcaops/storage/history/database';

import { getInvocationCwd, getInvocationEnv } from './invocation-context.js';
import { resolveExplicitOverride } from './resolve-root.js';
import { deriveThreadStatus } from './thread-status.js';

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
   * prefix-aware nudge without opening project history.
   */
  | { kind: 'static'; prefix: string }
  | {
      kind: 'ready';
      branch: string;
      prefix: string;
      cacheStatus: 'available' | 'missing';
      inFlight: SessionStartArtifact[];
    };

export interface SessionStartLocation {
  /** The worktree the hook runs in (an explicit override wins over discovery). */
  root: string;
  /** The one-shot git probe, or null when git could not answer for `root`. */
  probe: WorktreeProbe | null;
}

/**
 * Locate the checkout with ONE git process. The explicit `--root` /
 * `ORCAOPS_ROOT` override still wins; the probe then runs there so the branch
 * and common dir describe the overridden checkout. No `.git`-walking
 * fallback: a personal install cannot be found safely when git cannot
 * resolve the common dir, and guessing one would read shared state that may
 * belong to another repository.
 */
export async function resolveSessionStartLocation(
  cwd?: string
): Promise<SessionStartLocation | null> {
  const base = path.resolve(cwd ?? getInvocationCwd());
  const override = await resolveExplicitOverride(base);
  const probe = await probeWorktree(override ?? base);
  if (override !== null) return { root: override, probe };
  if (probe === null) return null;
  return { root: probe.worktreeRoot, probe };
}

/** The worktree root alone — kept for callers that only need the location. */
export async function resolveSessionStartRoot(cwd?: string): Promise<string | null> {
  return (await resolveSessionStartLocation(cwd))?.root ?? null;
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
 *  - **No application writes** — the canonical history scope opens only existing project
 *    databases in reader mode. Missing history stays missing; this hook never
 *    initializes, migrates, repairs, adopts, observes, or focuses anything.
 */
export async function readSessionStartState(
  cwd?: string,
  resolved?: SessionStartLocation | null
): Promise<SessionStartState> {
  try {
    const location = resolved === undefined ? await resolveSessionStartLocation(cwd) : resolved;
    if (!location) return { kind: 'uninitialized' };
    const repoRoot = location.root;
    // Governed by a config — this worktree's own, or the shared personal one
    // in the git common dir — never "has a .orcaops directory": a personal
    // sibling has no local directory until it captures. The probe's common
    // dir is reused so this costs no second git process.
    const source = await resolveConfigSource(repoRoot, {
      commonDir: location.probe?.commonDir,
    });
    if (source.kind === 'none') return { kind: 'uninitialized' };
    const config = configFromSource(source);
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

    // The branch came with the probe; only an overridden root that git could
    // not describe has to fall back to the static nudge.
    let branch = location.probe?.branch ?? null;
    if (branch === null) {
      try {
        branch = await new Repo(repoRoot).getCurrentBranch();
      } catch {
        return { kind: 'static', prefix };
      }
    }
    if (branch === 'HEAD') branch = 'detached HEAD';

    let scope: Awaited<ReturnType<typeof resolveDatabaseHistoryScope>>;
    try {
      scope = await resolveDatabaseHistoryScope({
        cwd: repoRoot,
        profile: 'status',
        selector: { scope: 'project' },
        env: getInvocationEnv(),
      });
    } catch {
      return { kind: 'ready', branch, prefix, cacheStatus: 'missing', inFlight: [] };
    }
    try {
      if (scope.projects.length === 0)
        return { kind: 'ready', branch, prefix, cacheStatus: 'missing', inFlight: [] };
      const project = scope.projects[0];
      if (scope.projects.length !== 1 || !project) return { kind: 'static', prefix };
      if (!project.database) {
        const exists = project.authority
          ? await inspectHistoryPath(
              scope.root.resolvedRoot,
              projectDatabasePath(project.authority)
            )
          : null;
        return exists === null
          ? { kind: 'ready', branch, prefix, cacheStatus: 'missing', inFlight: [] }
          : { kind: 'static', prefix };
      }
      const snapshot = readProjectTaskContext(project.database, { branch });
      const nowMs = Date.now();
      const inFlight: SessionStartArtifact[] = snapshot.artifacts.flatMap(
        ({ row, details, lifecycles }) => {
          const thread = deriveThreadStatus({
            artifact: {
              id: row.artifactId,
              task: details.task,
              branch: row.branch,
              status: row.completedAt === null ? 'active' : 'complete',
              started_at: row.startedAt,
              completed_at: row.completedAt,
            },
            planStepCount: details.planStepIds.length,
            checkpoints: [
              ...details.closedCheckpoints.map((checkpoint) => ({
                ...checkpoint,
                status: 'closed',
              })),
              ...details.openCheckpoints,
            ],
            hasSummary: row.completedAt !== null,
            lifecycles: lifecycles.map((entry) => entry.record),
            evaluatorRuns: details.evaluatorRuns,
          });
          if (thread.status === 'complete' || row.state === 'summarized') return [];
          return [
            {
              id: row.artifactId,
              label:
                row.label && row.label !== 'unlabelled' ? row.label : (row.task ?? row.artifactId),
              state: row.state,
              checkpointCount: row.checkpointCount,
              openCheckpoints: details.openCheckpoints.map((checkpoint) => {
                const openedMs = new Date(checkpoint.opened_at).getTime();
                return {
                  n: checkpoint.n,
                  openedAt: checkpoint.opened_at,
                  idleHours: Number.isFinite(openedMs)
                    ? Math.max(0, (nowMs - openedMs) / 3_600_000)
                    : null,
                };
              }),
            },
          ];
        }
      );
      return { kind: 'ready', branch, prefix, cacheStatus: 'available', inFlight };
    } catch {
      return { kind: 'static', prefix };
    } finally {
      scope.close();
    }
  } catch {
    return { kind: 'uninitialized' };
  }
}
