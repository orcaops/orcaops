// UI-side review-data loader. Mirrors snapshot.ts/pollSnapshot: spawn the app's
// own Node sidecar once (`review data --branch <b> --json`) so the sqlite/git
// floor assembly stays off the Bun UI, then resolve the independently installed
// routine Story through the engine-owned current pointer. Renderer-free (the
// src/data rule).

import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
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
  CURRENT_STORY_POINTER_FILE,
  loadCurrentSemanticAnchorGeneration,
  resolveCurrentStory,
  SEMANTIC_ANCHOR_CURRENT_FILE,
  SEMANTIC_ANCHOR_MANIFEST_FILE,
  SEMANTIC_ANCHOR_MODEL_FILE,
  type SemanticAnchorModel,
  STORY_REVIEW_MODEL_FILE,
  type StoryReviewModel,
} from '@orcaops/review-engine';

import { reviewFloorLockKey, reviewLocksDir, withReviewLock } from './reviewLock';
import { parseSidecarSchemaError } from './sidecarError';
import { resolveSidecar, sidecarMissingError } from './sidecarPath';
import { readWorktreeProbe } from './staleness';

const execFileAsync = promisify(execFile);

/**
 * Run the expensive producer in its own POSIX process group. AbortSignal support
 * on execFile terminates only the direct child; review generation can have a Git
 * diff or blame beneath it, so quitting the TUI must terminate the whole group.
 */
function runReviewSidecar(
  node: string,
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(node, [...argv], {
      env: options.env,
      detached,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const maxStderrBytes = 4 * 1024 * 1024;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxStderrBytes) return;
      const retained = chunk.subarray(0, maxStderrBytes - stderrBytes);
      stderrChunks.push(retained);
      stderrBytes += retained.byteLength;
    });
    const abortProcessGroup = () => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error);
        }
      } else {
        child.kill('SIGTERM');
      }
      reject(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        })
      );
    };
    const cleanup = () => options.signal?.removeEventListener('abort', abortProcessGroup);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, killedBy) => {
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const structuredError = parseSidecarSchemaError(stderr);
      if (structuredError !== null) {
        reject(structuredError);
        return;
      }
      reject(
        new Error(
          `review data sidecar exited ${code ?? `after ${killedBy ?? 'an unknown signal'}`}` +
            (stderr.length > 0 ? `: ${stderr}` : '')
        )
      );
    });
    options.signal?.addEventListener('abort', abortProcessGroup, { once: true });
    if (options.signal?.aborted) abortProcessGroup();
  });
}

/**
 * The routine two-lane run's canonical Story review model, discovered next to the
 * floor (`.orcaops/reviews/<slug>/twolane/<run-id>/story-review-model-v4.json`).
 * It is selected only by the authoritative current pointer. `status`:
 *   · `absent`  — no routine run installed a model.
 *   · `stale`   — a model exists but was built against a different floor.
 *   · `invalid` — a model exists but is unreadable/malformed.
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
  /** Run/pointer identity for run-scoped anchors and diagnostics. */
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
   * Whether the deterministic projections could be built from floor + diff.patch.
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
   * The raw `base→pinned` unified diff the floor was derived from (the sidecar
   * writes it beside `floor.json`). The Walk splits it per file and
   * position-matches floor hunks to it. Empty string when there is no diff
   * (degenerate scope) or the file is absent — the Walk degrades, never throws.
   */
  reviewDiff: string;
  /**
   * The resolved repo root + branch slug this review was loaded against — the
   * coordinates gap expansion's tree-source fetchers key their pinned refs
   * (refs/orcaops/review/<slug>[-base]) off at parse time.
   */
  root: string;
  slug: string;
  /**
   * The `git status --porcelain` digest at LOAD time — the dirty-state baseline
   * for the passive staleness banner. Later ticks compare the live digest
   * against it to catch a worktree that moved after the floor was read (the
   * floor's `scope.head_sha` catches a floor built against an older HEAD).
   * Read-only capture — never mints a git object.
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
  /** Explicit confirmation that this invocation may rebuild an older disposable cache. */
  rebuildCache?: boolean;
}

/**
 * File-generation tokens for independently reloadable review layers. They are
 * deliberately derived from the installed files, not the Watch heartbeat: a
 * wall-clock tick is not a content change. Atomic writers replace files, so
 * inode + size + nanosecond mtime distinguish generations without reading or
 * hashing multi-megabyte payloads on every passive probe.
 */
export interface ReviewGenerations {
  bundle: string | null;
  /** Validated Story content identity, independent of which run installed it. */
  story: string | null;
  /** Run/pointer identity, so same-content finalizations still refresh anchors. */
  storyInstallation: string | null;
  /** Anchor pointer/manifest/model identity inside the selected Story run. */
  storyAnchors: string | null;
  journal: string | null;
  comments: string | null;
}

async function fileGeneration(file: string): Promise<string | null> {
  try {
    const value = await stat(file, { bigint: true });
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function combinedGeneration(files: readonly string[]): Promise<string | null> {
  const generations = await Promise.all(files.map(fileGeneration));
  return generations.every((generation) => generation === null)
    ? null
    : generations.map((generation) => generation ?? '-').join('|');
}

interface StoryGenerationProbe {
  story: string | null;
  storyInstallation: string | null;
  storyAnchors: string | null;
}

const storyGenerationCache = new Map<
  string,
  { filesToken: string; result: StoryGenerationProbe }
>();

function safeGenerationId(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) &&
    path.basename(value) === value
    ? value
    : null;
}

async function storyFilesToken(reviewDir: string, runId: string | null): Promise<string | null> {
  const pointer = await fileGeneration(path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE));
  if (pointer === null) return null;
  if (runId === null) return pointer;
  const runDir = path.join(reviewDir, 'twolane', runId);
  const selected = await combinedGeneration([
    path.join(runDir, 'run-v1.json'),
    path.join(runDir, 'run-record-v1.json'),
    path.join(runDir, STORY_REVIEW_MODEL_FILE),
  ]);
  return `${pointer}|${runId}|${selected ?? '-'}`;
}

async function storyAnchorsToken(reviewDir: string, runId: string | null): Promise<string | null> {
  if (runId === null) return null;
  const anchorsDir = path.join(reviewDir, 'twolane', runId, 'anchors');
  const pointerFile = path.join(anchorsDir, SEMANTIC_ANCHOR_CURRENT_FILE);
  const pointerToken = await fileGeneration(pointerFile);
  if (pointerToken === null) return null;

  let generationId: string | null = null;
  try {
    const pointer = JSON.parse(await readFile(pointerFile, 'utf8')) as {
      generation_id?: unknown;
    };
    generationId = safeGenerationId(pointer.generation_id);
  } catch {
    // The pointer token is enough to invalidate the loader, which owns the
    // detailed invalid diagnosis.
  }
  if (generationId === null) return pointerToken;
  const generationDir = path.join(anchorsDir, 'generations', generationId);
  const generationToken = await combinedGeneration([
    path.join(generationDir, SEMANTIC_ANCHOR_MANIFEST_FILE),
    path.join(generationDir, SEMANTIC_ANCHOR_MODEL_FILE),
  ]);
  return `${pointerToken}|${generationId}|${generationToken ?? '-'}`;
}

/**
 * Poll only the current pointer and the run it names. No pointer means no
 * passive Story generation; full loading may still diagnose retired files once.
 */
async function probeStoryGeneration(reviewDir: string): Promise<StoryGenerationProbe> {
  const pointerFile = path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE);
  const pointerToken = await fileGeneration(pointerFile);
  if (pointerToken === null) return { story: null, storyInstallation: null, storyAnchors: null };

  let runId: string | null = null;
  try {
    const pointer = JSON.parse(await readFile(pointerFile, 'utf8')) as { run_id?: unknown };
    runId = safeGenerationId(pointer.run_id);
  } catch {
    // The pointer token alone invalidates the loader, which reports the detail.
  }
  const storyInstallation = (await storyFilesToken(reviewDir, runId)) ?? pointerToken;
  const anchorsInstallation = await storyAnchorsToken(reviewDir, runId);
  const filesToken = `${storyInstallation}|anchors:${anchorsInstallation ?? '-'}`;
  const cached = storyGenerationCache.get(reviewDir);
  if (cached?.filesToken === filesToken) return cached.result;

  const resolved = await resolveCurrentStory({ reviewDir });
  const result: StoryGenerationProbe = {
    story: resolved.status === 'OK' && resolved.generation !== null ? resolved.generation : null,
    storyInstallation,
    storyAnchors: anchorsInstallation,
  };
  storyGenerationCache.set(reviewDir, { filesToken, result });
  return result;
}

/** Cheap, read-only invalidation probe used by an already-open review. */
export async function readReviewGenerations(
  opts: Pick<LoadReviewOptions, 'root' | 'branch'>
): Promise<ReviewGenerations> {
  const root = await resolveRoot(opts.root);
  const dir = path.join(root, '.orcaops', 'reviews', slugifyBranch(opts.branch));
  const [bundle, story, journal, comments] = await Promise.all([
    combinedGeneration([
      path.join(dir, 'floor-cache.json'),
      path.join(dir, 'floor.json'),
      path.join(dir, 'diff.patch'),
    ]),
    probeStoryGeneration(dir),
    fileGeneration(path.join(dir, 'journal.ndjson')),
    fileGeneration(path.join(dir, 'comments.ndjson')),
  ]);
  return {
    bundle,
    story: story.story,
    storyInstallation: story.storyInstallation,
    storyAnchors: story.storyAnchors,
    journal,
    comments,
  };
}

/**
 * The repo root to scope the review to. An explicit root wins; otherwise resolve
 * git-toplevel from the cwd — NOT the raw cwd, which is a subdirectory when the
 * app is launched via its dev script (cwd = apps/orcaops-watch), pointing the
 * store at an empty `.orcaops` and yielding a 0-artifact degraded review. This
 * mirrors how the cockpit's snapshot source resolves the repo.
 */
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
 * Parse + VALIDATE floor JSON (from the sidecar-written floor.json cache).
 *
 * Schema-parse rather than cast: a duck-type check over a few keys is a shape
 * assumption, not a shape check. A floor from a different schema version can
 * satisfy it and then render as a review with zero threads and nothing to read
 * — an empty review that looks complete rather than an error. Fail loudly here.
 */
export function parseFloor(text: string): Floor {
  const parsed = floorSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `unreadable review floor (${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'})` +
        ' — rebuild the review bundle'
    );
  }
  return parsed.data;
}

/**
 * Whether the deterministic projections the floor route depends on could be
 * built at all. It fails when the floor and `diff.patch` disagree — a missing,
 * empty, or truncated patch makes owned rows unknown, so coverage cannot be
 * computed and `mark reviewed` must remain unavailable.
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

/**
 * Thin Watch adapter over the engine-owned authoritative resolver. Selection is
 * by the terminal current-story pointer, never filesystem mtime; an invalid
 * current installation stays visible and never falls back to an older run.
 */
export async function loadRoutineStoryOverlay(input: {
  dir: string;
  floor: Floor;
}): Promise<RoutineStoryOverlay> {
  const resolved = await resolveCurrentStory({
    reviewDir: input.dir,
    floorInputHash: input.floor.input_hash,
  });
  const coherent =
    resolved.status !== 'OK' ||
    (resolved.model !== null && resolved.generation !== null && resolved.runId !== null);
  const status: RoutineStoryOverlay['status'] =
    resolved.status === 'OK' && coherent
      ? 'ok'
      : resolved.status === 'OK'
        ? 'invalid'
        : (resolved.status.toLowerCase() as RoutineStoryOverlay['status']);
  let anchors: RoutineStoryAnchors = {
    model: null,
    status: 'absent',
    issue: null,
    generation: null,
  };
  // Anchors load for a STALE story too: its generation is still internally
  // validated against its finalized run, and the viewer reconciles individual
  // targets against the current diff. A generation that itself reports
  // STALE/INVALID stays unloaded — its loader intentionally omits the model
  // and says not to reinterpret it.
  if ((status === 'ok' || status === 'stale') && resolved.runId !== null) {
    const loaded = await loadCurrentSemanticAnchorGeneration(
      path.join(input.dir, 'twolane', resolved.runId)
    );
    if (loaded.status === 'OK') {
      anchors = {
        model: loaded.model,
        status: 'ok',
        issue: null,
        generation: loaded.model.generation_id,
      };
    } else if (loaded.status !== 'ABSENT') {
      anchors = {
        model: null,
        status: loaded.status.toLowerCase() as Exclude<
          RoutineStoryAnchors['status'],
          'absent' | 'ok'
        >,
        issue: loaded.reason,
        generation: null,
      };
    }
  }
  // A stale model is retained for best-effort viewing. Authority stays gated
  // on `status`: the default lens, finish basis, and journal identity all key
  // off status/generation elsewhere, never off model presence.
  const viewable = status === 'ok' || status === 'stale';
  return {
    model: viewable ? resolved.model : null,
    status,
    issue:
      resolved.status === 'OK' && !coherent
        ? 'CURRENT_STORY_INVALID: resolver returned an incomplete OK result'
        : resolved.issue,
    runId: resolved.runId,
    generation: viewable ? resolved.generation : null,
    installationToken: await storyFilesToken(input.dir, safeGenerationId(resolved.runId)),
    anchors,
  };
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

  return {
    targetsStatus,
    eligibleTargets,
    currentThreads,
    currentGapRows,
  };
}

/**
 * Assemble a branch's review: the deterministic floor (via the sidecar) plus the
 * authoritative current routine Story.
 *
 * The sidecar writes `.orcaops/reviews/<slug>/floor.json` (the source of truth)
 * and prints only a small summary; we read the FILE rather than capture stdout,
 * because a multi-MB floor overruns the execFile stdout cap under Bun. Throws
 * only when the sidecar isn't built or the floor spawn/read fails.
 */
export async function loadReview(opts: LoadReviewOptions): Promise<ReviewData> {
  const sidecar = opts.sidecarPath ?? resolveSidecar();
  if (sidecar === null) {
    throw sidecarMissingError();
  }
  const root = await resolveRoot(opts.root);
  const env = { ...(opts.env ?? process.env) };
  env.ORCAOPS_ROOT = root;
  const node = opts.nodeBin ?? env.ORCAOPS_WATCH_NODE ?? 'node';
  const argv = [sidecar, 'review', 'data', '--branch', opts.branch];
  if (opts.base !== undefined && opts.base.length > 0) argv.push('--base', opts.base);
  if (opts.rebuildCache === true) argv.push('--rebuild-cache');
  // Await the sidecar (it writes floor.json before exit); its summary stdout is tiny.
  await runReviewSidecar(node, argv, { env, signal: opts.signal });

  return loadInstalledReview({ ...opts, root });
}

/**
 * Read the currently installed immutable bundle without invoking its producer.
 * Passive refreshes use this path: a read must never update generated_at, refs,
 * or any file watched by the process that requested the read.
 */
export async function loadInstalledReview(opts: LoadReviewOptions): Promise<ReviewData> {
  const root = await resolveRoot(opts.root);

  const slug = slugifyBranch(opts.branch);
  const dir = path.join(root, '.orcaops', 'reviews', slug);

  // Snapshot floor.json + diff.patch as ONE generation under the same per-slug
  // lock the sidecar installs them with — another sidecar (e.g. a background
  // floor refresh) could otherwise swap in a new bundle between these two reads,
  // pairing a floor from one generation with a patch from another. Reading a
  // NEWER generation than our own sidecar produced is fine; a MIXED one is not.
  // A lock timeout stays loud rather than returning a torn review.
  const { floor, reviewDiff } = await withReviewLock(
    reviewLocksDir(root),
    reviewFloorLockKey(slug),
    async () => {
      const floorText = await readFile(path.join(dir, 'floor.json'), 'utf8');
      const floor = parseFloor(floorText);
      // Preserve a missing patch as an unusable projection below: owned rows
      // remain unknown and coverage recording fails closed.
      let reviewDiff = '';
      try {
        reviewDiff = await readFile(path.join(dir, 'diff.patch'), 'utf8');
      } catch {
        reviewDiff = '';
      }
      return { floor, reviewDiff };
    },
    root
  );

  const projections = await loadReviewProjections({ floor, reviewDiff });
  const routineStory = await loadRoutineStoryOverlay({ dir, floor });
  // Capture the dirty-state baseline after the coherent bundle read. On an
  // active load the sidecar has just rebuilt it; on a passive installed read it
  // is the baseline the current surface actually represents. Read-only probe.
  const probe = await readWorktreeProbe(root);
  return {
    floor,
    ...projections,
    reviewDiff,
    root,
    slug,
    worktreeDigest: probe.porcelainDigest,
    worktreeHeadSha: probe.headSha,
    routineStory,
  };
}
