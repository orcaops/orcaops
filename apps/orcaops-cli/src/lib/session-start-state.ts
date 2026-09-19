import path from 'node:path';

import { type BootstrapContent, resolveBootstrapContent, type ToolId } from '@orcaops/adapters';
import {
  configFromSource,
  probeWorktree,
  Repo,
  resolveConfigSource,
  type WorktreeProbe,
} from '@orcaops/core';
import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import type { Config } from '@orcaops/storage';
import { inspectHistoryPath } from '@orcaops/storage/history/authority';
import { projectDatabasePath, readProjectTaskContext } from '@orcaops/storage/history/database';

import { instructionFileCarriesRouting } from './instruction-block.js';
import { getInvocationCwd, getInvocationEnv } from './invocation-context.js';
import { resolveManagedInstructionFiles } from './managed-instruction-files.js';
import { resolveExplicitOverride } from './resolve-root.js';
import { enabledSkillTemplates } from './skill-set.js';
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

/**
 * The bootstrap rows every emitting payload renders, plus whether the hook is
 * the only surface carrying skill routing. Both are resolved ONCE per session
 * start, before the payload branch, so the `static` short-circuit and every
 * degraded `ready` path render the same content model.
 */
export interface SessionStartBootstrap {
  content: BootstrapContent;
  /**
   * No managed block is actually carrying routing, so the hook renders its
   * own. See `resolveHooksOnly` for what "actually" means.
   */
  hooksOnly: boolean;
}

export type SessionStartState =
  | { kind: 'uninitialized' }
  /**
   * `session_hooks.payload: 'static'` (the default): the hook emits a fixed
   * prefix-aware nudge without opening project history.
   */
  | ({ kind: 'static'; prefix: string } & SessionStartBootstrap)
  | ({
      kind: 'ready';
      branch: string;
      prefix: string;
      cacheStatus: 'available' | 'missing';
      inFlight: SessionStartArtifact[];
    } & SessionStartBootstrap);

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
  resolved?: SessionStartLocation | null,
  agent?: ToolId
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
    // Resolved before the payload branch: `static` is also the degraded target
    // for every `ready`-path failure, so both kinds must carry the same rows.
    const bootstrap = await resolveSessionStartBootstrap(repoRoot, config, agent);

    // The payload mode is read fresh HERE, each session start — never baked
    // into the installed settings entries — so switching modes
    // (`orcaops update --session-hook-payload …`) takes effect on the next
    // session with no reinstall and no restart. Static short-circuits before
    // any state read: it works in a commitless repo and shrugs off a corrupt
    // cache, which is exactly its reduced failure surface.
    if (config.session_hooks.payload === 'static') {
      return { kind: 'static', prefix, ...bootstrap };
    }

    // The branch came with the probe; only an overridden root that git could
    // not describe has to fall back to the static nudge.
    let branch = location.probe?.branch ?? null;
    if (branch === null) {
      try {
        branch = await new Repo(repoRoot).getCurrentBranch();
      } catch {
        return { kind: 'static', prefix, ...bootstrap };
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
      return { kind: 'ready', branch, prefix, cacheStatus: 'missing', inFlight: [], ...bootstrap };
    }
    try {
      if (scope.projects.length === 0)
        return {
          kind: 'ready',
          branch,
          prefix,
          cacheStatus: 'missing',
          inFlight: [],
          ...bootstrap,
        };
      const project = scope.projects[0];
      if (scope.projects.length !== 1 || !project) return { kind: 'static', prefix, ...bootstrap };
      if (!project.database) {
        const exists = project.authority
          ? await inspectHistoryPath(
              scope.root.resolvedRoot,
              projectDatabasePath(project.authority)
            )
          : null;
        return exists === null
          ? { kind: 'ready', branch, prefix, cacheStatus: 'missing', inFlight: [], ...bootstrap }
          : { kind: 'static', prefix, ...bootstrap };
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
      return { kind: 'ready', branch, prefix, cacheStatus: 'available', inFlight, ...bootstrap };
    } catch {
      return { kind: 'static', prefix, ...bootstrap };
    } finally {
      scope.close();
    }
  } catch {
    return { kind: 'uninitialized' };
  }
}

/**
 * Resolve the content model the payload renders and whether the hook is the
 * only surface carrying routing.
 *
 * A resolution failure degrades to `fallbackBootstrapContent` rather than
 * propagating: the hook's contract is exit 0 with useful text, and the
 * lifecycle guidance is worth emitting even when a config's skill overrides or
 * hint keys cannot be resolved.
 */
async function resolveSessionStartBootstrap(
  repoRoot: string,
  config: Config,
  agent: ToolId | undefined
): Promise<SessionStartBootstrap> {
  const prefix = config.naming.prefix;
  try {
    const content = resolveBootstrapContent({
      prefix,
      // The cloud gate is hardcoded off because `resolveSkillGates` reads a
      // credentials file outside the repo, I/O this hook has never done. It is
      // routing-equivalent: no cloud-gated template declares a trigger line,
      // asserted in the adapters containment guard.
      enabledSkills: enabledSkillTemplates(config, { cloud: false }),
      hints: config.workflow.hints,
      commitInsideWindow: config.workflow.commit_inside_window,
      suppressedRouting: config.workflow.routing.suppress,
    });
    return { content, hooksOnly: await resolveHooksOnly(repoRoot, config, agent) };
  } catch {
    return { content: fallbackBootstrapContent(prefix), hooksOnly: false };
  }
}

/**
 * Is the hook the only surface carrying routing FOR THIS AGENT? True when the
 * block is the user's (`manual`), when the install manages no instruction file
 * the invoking agent loads, or when none of those files carries a managed block
 * whose own region holds the routing sentinel.
 *
 * Per-agent, not per-repository: the agent that loads AGENTS.md is not covered
 * by a block in CLAUDE.md. Doctor's payload check and its no-surface warning
 * both call this per agent for the same reason. An undetermined agent falls
 * back to the whole managed set.
 */
export async function resolveHooksOnly(
  repoRoot: string,
  config: Config,
  agent: ToolId | undefined
): Promise<boolean> {
  if (config.bootstrap === 'manual') return true;
  const files = resolveManagedInstructionFiles(config, agent);
  if (files.length === 0) return true;
  for (const rel of files) {
    if (await instructionFileCarriesRouting(repoRoot, rel)) return false;
  }
  return true;
}

/**
 * The degraded content: lifecycle and skip prose with no routing and no hints,
 * and the commit clause on — what the hook emitted before it resolved content
 * at all. Takes no config input beyond the prefix, so the config that broke
 * resolution cannot break this too.
 */
function fallbackBootstrapContent(prefix: string): BootstrapContent {
  const base = resolveBootstrapContent({
    prefix,
    enabledSkills: undefined,
    hints: undefined,
    commitInsideWindow: true,
    suppressedRouting: [],
  });
  return { ...base, routing: [], surveyTail: null, hints: [] };
}
