// UI-side review-data loader. Active loads produce through `review data`;
// passive loads only read `review pane`. Both use the app's Node sidecar so
// SQLite stays off the Bun UI, then build deterministic projections here.
// The floor and its diff are retained evidence, and the routine Story is
// the sealed run's retained publication, so nothing here reads a review
// directory file. Renderer-free (the src/data rule).

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import {
  type CurrentThreadManifest,
  type EligibleNarrativeTarget,
  type Floor,
  floorSchema,
  type ReviewedRow,
  slugifyBranch,
} from '@orcaops/review-core';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
  type DatabaseReviewPane,
  type PaneRoutineStory,
  type SemanticAnchorModel,
  type StoryReviewModel,
} from '@orcaops/review-engine';

import { resolveSidecar, sidecarMissingError } from './sidecarPath';
import { readWorktreeProbe } from './staleness';

/**
 * Upper bound on the pane payload collected from the sidecar's stdout. The diff
 * is bounded by `review.max_diff_bytes`, but this is explicit: a pane over the
 * cap is an error, never a silently truncated review.
 */
export const PANE_IO_CAP_BYTES = 64 * 1024 * 1024;

interface SidecarResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the sidecar in its own POSIX process group and collect its stdout
 * incrementally. AbortSignal support on the raw child terminates only the
 * direct child; a store read can have Git plumbing beneath it, so quitting the
 * TUI must terminate the whole group. Stdout past the cap rejects loudly — the
 * pane must never be silently cut.
 */
function spawnReviewSidecar(
  node: string,
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<SidecarResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        })
      );
      return;
    }
    const detached = process.platform !== 'win32';
    const child = spawn(node, [...argv], {
      env: options.env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortProcessGroup = (): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            fail(error as Error);
            return;
          }
        }
      } else {
        child.kill('SIGTERM');
      }
      fail(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        })
      );
    };
    const cleanup = (): void => options.signal?.removeEventListener('abort', abortProcessGroup);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > PANE_IO_CAP_BYTES) {
        child.kill();
        fail(
          new Error(
            `review pane: payload exceeded the ${PANE_IO_CAP_BYTES / (1024 * 1024)}MB cap — refusing to truncate`
          )
        );
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= PANE_IO_CAP_BYTES) errChunks.push(chunk);
    });
    child.once('error', fail);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8').trim(),
      });
    });
    options.signal?.addEventListener('abort', abortProcessGroup, { once: true });
    if (options.signal?.aborted) abortProcessGroup();
  });
}

/**
 * The routine two-lane run's canonical Story review model. It is selected only
 * by the review's retained Story selection. `status`:
 *   · `absent`  — no routine run sealed a Story.
 *   · `stale`   — a Story exists but was sealed against a different floor.
 *   · `invalid` — a Story exists but its retained model is unreadable.
 *   · `ok`      — a current, schema-valid model is available to render.
 */
export interface RoutineStoryOverlay {
  model: StoryReviewModel | null;
  status: 'absent' | 'stale' | 'invalid' | 'ok';
  issue: string | null;
  /** The run id the model came from, for provenance and refresh keys. */
  runId: string | null;
  /** Validated Story content identity; null unless the current floor can read it. */
  generation: string | null;
  /** Run identity, so same-content finalizations still refresh anchors. */
  installationToken: string | null;
  /**
   * Optional semantic context installed inside this exact run. Anchors never
   * select a Story (or another run) on their own.
   */
  anchors: RoutineStoryAnchors;
}

export interface RoutineStoryAnchors {
  model: SemanticAnchorModel | null;
  status: 'absent' | 'stale' | 'invalid' | 'ok';
  issue: string | null;
  /** Immutable anchor-generation identity, when a valid generation is installed. */
  generation: string | null;
}

export interface ReviewData {
  floor: Floor;
  /**
   * Whether the deterministic projections could be built from floor + diff.
   * When this is not ok, owned rows are unknown and coverage cannot be recorded —
   * the reader must say so rather than present a review that silently cannot
   * accept `mark reviewed`.
   */
  targetsStatus: ReviewTargetsStatus;
  /** Exact engine-minted target packet used to validate the installed aggregate. */
  eligibleTargets: EligibleNarrativeTarget[];
  /** Current owned-row manifests used by v2 replay and atomic Part coverage. */
  currentThreads: CurrentThreadManifest[];
  /** Content-addressed gap rows; never includes a non-durable slice ordinal. */
  currentGapRows: ReviewedRow[];
  /**
   * The raw `base→pinned` unified diff the floor was derived from — the retained
   * diff evidence member. The Walk splits it per file and position-matches floor
   * hunks to it. Empty string when there is no diff (degenerate scope) — the Walk
   * degrades, never throws.
   */
  reviewDiff: string;
  /**
   * The resolved repo root + branch slug this review was loaded against — the
   * coordinates gap expansion's tree-source fetchers key their pinned refs off.
   */
  root: string;
  slug: string;
  /**
   * The `git status --porcelain` digest at LOAD time — the dirty-state baseline
   * for the passive staleness banner. Later ticks compare the live digest against
   * it to catch a worktree that moved after the floor was read. Read-only capture.
   */
  worktreeDigest: string;
  /** Live HEAD captured by the same read-only load-time probe. */
  worktreeHeadSha: string | null;
  /** The routine two-lane Story review model overlay (version-dispatched lens). */
  routineStory: RoutineStoryOverlay;
}

export interface LoadReviewOptions {
  /** Repo root; when omitted, resolved from git-toplevel (like the cockpit). */
  root?: string;
  branch: string;
  base?: string;
  env?: NodeJS.ProcessEnv;
  /** Node binary to run the sidecar under (default: `node` on PATH). */
  nodeBin?: string;
  /** Explicit sidecar executable for production-seam tests; production resolves its built sidecar. */
  sidecarPath?: string;
  /** Cancels the one-shot sidecar when review mode exits or a newer load supersedes it. */
  signal?: AbortSignal;
}

/**
 * File-generation tokens for independently reloadable review layers. They are
 * the review's retained selection versions, read cheaply through the sidecar's
 * `--generations-only` mode: a heartbeat probes them without loading the floor.
 */
export interface ReviewGenerations {
  bundle: string | null;
  /** Validated Story content identity, independent of which run installed it. */
  story: string | null;
  /** Run identity, so same-content finalizations still refresh anchors. */
  storyInstallation: string | null;
  /** Anchor generation identity inside the selected Story run. */
  storyAnchors: string | null;
  journal: string | null;
  comments: string | null;
}

/**
 * The repo root to scope the review to. An explicit root wins; otherwise resolve
 * git-toplevel from the cwd — NOT the raw cwd, which is a subdirectory when the
 * app is launched via its dev script (cwd = apps/orcaops-watch), pointing the
 * store at an empty `.orcaops` and yielding a 0-artifact degraded review.
 */
const execFileAsync = promisify(execFile);

export async function resolveRoot(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
    });
    const top = String(stdout).trim();
    if (top.length > 0) return top;
  } catch {
    // not inside a git repo — fall back to the cwd
  }
  return process.cwd();
}

/**
 * Parse + VALIDATE floor JSON. Schema-parse rather than cast: a floor from a
 * different schema version can satisfy a duck-type check and render as a review
 * with zero threads and nothing to read. Fail loudly here.
 */
export function parseFloor(value: unknown): Floor {
  const parsed = floorSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `unreadable review floor (${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'})` +
        ' — republish the review with `review data`'
    );
  }
  return parsed.data;
}

/**
 * Whether the deterministic projections the floor route depends on could be
 * built at all. It fails when the floor and its diff disagree — a missing, empty
 * or truncated diff makes owned rows unknown, so coverage cannot be computed and
 * `mark reviewed` must remain unavailable.
 */
export type ReviewTargetsStatus = { ok: true } | { ok: false; reason: string };

export interface ReviewProjections {
  targetsStatus: ReviewTargetsStatus;
  eligibleTargets: EligibleNarrativeTarget[];
  currentThreads: CurrentThreadManifest[];
  currentGapRows: ReviewedRow[];
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the floor-derived coverage projections without consulting any lens. */
export async function loadReviewProjections(input: {
  floor: Floor;
  reviewDiff: string;
}): Promise<ReviewProjections> {
  const { floor, reviewDiff } = input;
  let targetsStatus: ReviewTargetsStatus = { ok: true };
  let eligibleTargets: EligibleNarrativeTarget[] = [];
  let currentThreads: CurrentThreadManifest[] = floor.outline.threads.map((section) => ({
    threadKey: section.threadKey,
    rows: null,
    digest: null,
  }));
  let currentGapRows: ReviewedRow[] = [];

  try {
    eligibleTargets = await buildEligibleNarrativeTargets(floor, reviewDiff);
    currentThreads = await buildCurrentThreadManifests(floor, eligibleTargets);
    currentGapRows = await buildCurrentGapRows(floor, reviewDiff);
  } catch (error) {
    targetsStatus = { ok: false, reason: failureReason(error) };
    // currentThreads keeps its null-row seed: owned rows are genuinely unknown.
  }

  return { targetsStatus, eligibleTargets, currentThreads, currentGapRows };
}

/**
 * Map the canonical pane's routine Story into the overlay the pane renders. A
 * stale Story is retained for best-effort viewing; authority stays gated on
 * `status`/`generation` elsewhere, never on model presence.
 */
export function loadRoutineStoryOverlay(routineStory: PaneRoutineStory): RoutineStoryOverlay {
  return {
    model:
      routineStory.status === 'ok' || routineStory.status === 'stale' ? routineStory.model : null,
    status: routineStory.status,
    issue: routineStory.issue,
    runId: routineStory.runId,
    generation:
      routineStory.status === 'ok' || routineStory.status === 'stale'
        ? routineStory.generation
        : null,
    installationToken: routineStory.runId,
    anchors: {
      model: routineStory.anchors.status === 'ok' ? routineStory.anchors.model : null,
      status: routineStory.anchors.status,
      issue: routineStory.anchors.issue,
      generation: routineStory.anchors.generation,
    },
  };
}

interface PaneEnvelope {
  ok: boolean;
  code?: string;
  message?: string;
}

export class ReviewPaneError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ReviewPaneError';
  }
}

export class ReviewDataError extends Error {
  readonly code: string | null;

  constructor(exitCode: number, stderr: string) {
    super(`review data sidecar exited ${exitCode}${stderr.length > 0 ? `: ${stderr}` : ''}`);
    this.name = 'ReviewDataError';
    this.code = /^review data \(operation [^)]+\): ([A-Z_]+): /mu.exec(stderr)?.[1] ?? null;
  }
}

async function runReviewVerb(
  opts: LoadReviewOptions,
  verb: 'data' | 'pane',
  extraArgs: readonly string[]
): Promise<{ root: string; result: SidecarResult }> {
  const sidecar = opts.sidecarPath ?? resolveSidecar();
  if (sidecar === null) throw sidecarMissingError();
  const root = await resolveRoot(opts.root);
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), ORCAOPS_ROOT: root };
  const node = opts.nodeBin ?? env.ORCAOPS_WATCH_NODE ?? 'node';
  const argv = [sidecar, 'review', verb, '--branch', opts.branch, ...extraArgs];
  const result = await spawnReviewSidecar(node, argv, { env, signal: opts.signal });
  return { root, result };
}

async function runDataVerb(opts: LoadReviewOptions): Promise<void> {
  // JSON success prints the entire floor; only the bounded summary is needed here.
  const { result } = await runReviewVerb(
    opts,
    'data',
    opts.base === undefined ? [] : ['--base', opts.base]
  );
  if (result.code !== 0) {
    throw new ReviewDataError(result.code, result.stderr);
  }
}

async function runPaneVerb(
  opts: LoadReviewOptions,
  extraArgs: readonly string[]
): Promise<{ root: string; payload: Record<string, unknown> }> {
  const { root, result } = await runReviewVerb(opts, 'pane', ['--json', ...extraArgs]);
  if (result.code !== 0) {
    const envelope = safeEnvelope(result.stdout);
    if (envelope !== null && envelope.ok === false) {
      const code = envelope.code ?? 'HISTORY_INACCESSIBLE';
      throw new ReviewPaneError(code, envelope.message ?? `review pane: ${code}`);
    }
    throw new Error(
      `review pane sidecar exited ${result.code}${result.stderr.length > 0 ? `: ${result.stderr}` : ''}`
    );
  }
  const payload = safeEnvelope(result.stdout);
  if (payload === null || payload.ok !== true)
    throw new Error('review pane: the sidecar returned an unreadable envelope');
  return { root, payload: payload as unknown as Record<string, unknown> };
}

function safeEnvelope(text: string): PaneEnvelope | null {
  try {
    const value = JSON.parse(text) as PaneEnvelope;
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Explicit loads refresh evidence; the producer retains an unchanged floor. */
export async function loadReview(opts: LoadReviewOptions): Promise<ReviewData> {
  await runDataVerb(opts);
  return loadInstalledReview(opts);
}

/** Read and project retained evidence without publishing during passive refresh. */
export async function loadInstalledReview(opts: LoadReviewOptions): Promise<ReviewData> {
  const { root, payload } = await runPaneVerb(opts, []);
  const pane = payload as unknown as DatabaseReviewPane & { ok: true };
  const floor = parseFloor(pane.floor);
  const reviewDiff = typeof pane.diff === 'string' ? pane.diff : '';
  const projections = await loadReviewProjections({ floor, reviewDiff });
  const routineStory = loadRoutineStoryOverlay(pane.routineStory);
  const probe = await readWorktreeProbe(root);
  return {
    floor,
    ...projections,
    reviewDiff,
    root,
    slug: slugifyBranch(opts.branch),
    worktreeDigest: probe.porcelainDigest,
    worktreeHeadSha: probe.headSha,
    routineStory,
  };
}

/** Cheap, read-only invalidation probe used by an already-open review. */
export async function readReviewGenerations(
  opts: Pick<LoadReviewOptions, 'root' | 'branch' | 'env' | 'nodeBin' | 'sidecarPath' | 'signal'>
): Promise<ReviewGenerations> {
  const { payload } = await runPaneVerb(opts, ['--generations-only']);
  const generations = (payload.generations ?? {}) as DatabaseReviewPane['generations'];
  return {
    bundle: generations.floor ?? null,
    story: generations.story ?? null,
    storyInstallation: generations.storyInstallation ?? null,
    storyAnchors: generations.storyAnchors ?? null,
    journal: generations.workflow ?? null,
    comments: generations.comments ?? null,
  };
}
