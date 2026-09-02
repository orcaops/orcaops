// The `review …` sidecar subcommands. Invoked as
// `node dist/sidecar.js review data --branch <b> [--json] [--base <sha>]`.
// Prints the assembled floor JSON to stdout and caches it under
// .orcaops/reviews/<branch-slug>/floor.json. Diagnostics go to stderr only.

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  type ExecutableIdentity,
  type Floor,
  floorSchema,
  slugifyBranch,
} from '@orcaops/review-core';
import { ArtifactLockLeaseLostError, atomicWriteFile } from '@orcaops/storage';

import { runAnchor } from './anchor.js';
import { saveBlameCache } from './blameCache.js';
import { runClaimLedger } from './claimLedgerCli.js';
import { runCommentAction, runComments } from './comments.js';
import {
  AccountCorpusCeilingError,
  ExcludePolicyError,
  ForensicTransportCeilingError,
  ReviewDiffTruncatedError,
  StubPolicyError,
} from './dossier.js';
import { buildAndWriteDossier, runDossier } from './dossierCli.js';
import { runDurableState } from './durableState.js';
import {
  buildFloor,
  type BuildFloorResult,
  computeFloorFingerprint,
  FLOOR_PRODUCER_VERSION,
  type FloorBuildStage,
  type FloorBuildStageTiming,
  isFloorCacheHealthClean,
} from './floor.js';
import { commitTree, runGit } from './git.js';
import { runJournal } from './journal.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath } from './reviewPaths.js';
import {
  ensureReviewStateVersion,
  inspectReviewStateVersion,
  ReviewStateHealthError,
  reviewStateLockKey,
} from './reviewState.js';
import {
  defaultReviewRuntimeDescriptor,
  observeReviewExecutableIdentity,
  type ReviewRuntimeDescriptor,
} from './runtimeIdentity.js';
import { resolveScopeInputs } from './scope.js';
import { runSemanticAnchorSubmit } from './semanticAnchorCli.js';
import { clearStickyBase, STICKY_BASE_AUTO_SENTINEL, writeStickyBase } from './stickyBase.js';
import { reviewVerbFailure, runTwolaneRun, TWOLANE_RUN_VERBS } from './twolaneRunCli.js';

export interface ReviewArgs {
  cmd: string;
  sub: string | undefined;
  branch?: string;
  base?: string;
  root?: string;
  /**
   * `review journal` only: a JSON-encoded journal event — or a JSON ARRAY of
   * events (a batch; all-or-nothing) — to validate + append before reading back.
   */
  addEvent?: string;
  /** Action for `review comment` or `review state`. */
  action?: string;
  /** `review comment reply|resolve` only: the target comment id. */
  id?: string;
  /**
   * `review comment add|reply`: a JSON-encoded `{body, author?, anchor?/checkpoint_ref?}`.
   * `review journal`: `-` to read the event/batch JSON from stdin (the
   * large-payload transport — same semantics as --add, capped + loud on oversize).
   */
  input?: string;
  /** `review comment resolve` only: who resolves (`reviewer` | `agent`). */
  author?: string;
  /** `review comment reply --resolve`: also resolve the comment with the reply. */
  resolve?: boolean;
  /** `review anchor` only: the anchored file / diff side / 1-based line range. */
  file?: string;
  side?: string;
  start?: string;
  end?: string;
  /** `review anchor` only: `<kind>:<scope>:<origin>` for a finding key. */
  finding?: string;
  /** `review anchor` only: anchor ids (hunkKeys / citation ids) — repeatable. */
  refs?: string[];
  /** `review anchor --hunk`: auto-pick the anchor line from this floor hunk. */
  hunk?: string;
  /** Two-lane run lifecycle (`start`/`lane-input`/`lane-submit`/`run-show`/`finalize`). */
  runId?: string;
  /** `review semantic-anchor-submit` only: pending generation to repair once. */
  generationId?: string;
  lane?: string;
  isolation?: string;
  usageTokens?: string;
  usageSource?: string;
  /** Optional strict JSON object with field-level host/model provenance for routine review. */
  executionProfileJson?: string;
  /** `review dossier`: budget profile (`routine` ~8k/lane | `full`). */
  profile?: string;
  /** Engine-internal observation supplied by the public CLI or sidecar adapter. */
  runtimeIdentity?: ExecutableIdentity;
  unknownArguments?: string[];
  /** `--help` on any verb prints its usage. */
  help?: boolean;
  /** `review data` only: explicitly rebuild the disposable SQLite projection. */
  rebuildCache?: boolean;
  json: boolean;
}

export function parseReviewArgs(argv: readonly string[]): ReviewArgs {
  const args: ReviewArgs = { cmd: argv[0] ?? '', sub: argv[1], json: false };
  // Review verbs with an action carry it as a positional third token.
  let flagStart = 2;
  if (args.sub === 'comment' || args.sub === 'state') {
    if (argv[2] === '--help' || argv[2] === '-h') {
      args.action = 'help';
      args.help = true;
    } else {
      args.action = argv[2];
    }
    flagStart = 3;
  }
  for (let i = flagStart; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--add') args.addEvent = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--author') args.author = argv[++i];
    else if (a === '--resolve') args.resolve = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--side') args.side = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--finding') args.finding = argv[++i];
    else if (a === '--hunk') args.hunk = argv[++i];
    else if (a === '--run') args.runId = argv[++i];
    else if (a === '--generation') args.generationId = argv[++i];
    else if (a === '--lane') args.lane = argv[++i];
    else if (a === '--isolation') args.isolation = argv[++i];
    else if (a === '--usage-tokens') args.usageTokens = argv[++i];
    else if (a === '--usage-source') args.usageSource = argv[++i];
    else if (a === '--execution-profile-json') args.executionProfileJson = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--rebuild-cache') args.rebuildCache = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--ref') {
      const ref = argv[++i];
      if (ref !== undefined) (args.refs ??= []).push(ref);
    } else if (a !== undefined) (args.unknownArguments ??= []).push(a);
  }
  return args;
}

export type ReviewRootResult = { ok: true; root: string } | { ok: false; message: string };

/**
 * Resolve the orcaops repo root: --root, then ORCAOPS_ROOT, then git toplevel.
 * Outside a git repo this FAILS rather than falling back to the cwd — a write
 * verb run from a stray cwd would otherwise create a stray `.orcaops` tree
 * there, and a registry-style guess cannot disambiguate multi-repo users.
 */
export async function resolveReviewRoot(
  env: NodeJS.ProcessEnv,
  override?: string,
  cwd: string = process.cwd()
): Promise<ReviewRootResult> {
  if (override && override.length > 0) return { ok: true, root: override };
  const fromEnv = env.ORCAOPS_ROOT;
  if (fromEnv && fromEnv.length > 0) return { ok: true, root: fromEnv };
  try {
    const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (top.code === 0) {
      const root = top.stdout.toString('utf8').trim();
      if (root.length > 0) return { ok: true, root };
    }
  } catch {
    // a git spawn failure lands in the same loud error below
  }
  return {
    ok: false,
    message:
      'not inside a git repository — run from the repo under review, or pass --root / set ORCAOPS_ROOT',
  };
}

/** Run a `review` subcommand. Returns the process exit code. */
export async function runReview(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
  runtime: ReviewRuntimeDescriptor = defaultReviewRuntimeDescriptor()
): Promise<number> {
  const args = parseReviewArgs(argv);

  // Help resolves before the root does — it must work from any cwd.
  if (args.sub === undefined || args.sub === 'help' || args.sub === '--help' || args.sub === '-h') {
    process.stdout.write(REVIEW_USAGE);
    return args.sub === undefined ? 2 : 0;
  }

  if (args.unknownArguments !== undefined) {
    process.stderr.write(`review: unknown argument(s): ${args.unknownArguments.join(', ')}\n`);
    return 2;
  }
  if (args.rebuildCache === true && args.sub !== 'data') {
    process.stderr.write('review: --rebuild-cache is only valid with `review data`\n');
    return 2;
  }

  const rootResult = await resolveReviewRoot(env, args.root, cwd);
  if (!rootResult.ok) {
    process.stderr.write(`review: ${rootResult.message}\n`);
    return 2;
  }
  const root = rootResult.root;

  if (
    args.branch !== undefined &&
    !['data', 'journal', 'state', 'routine-start'].includes(args.sub)
  ) {
    const dir = reviewDirPath(root, slugifyBranch(args.branch));
    const stateHealth = await inspectReviewStateVersion(dir);
    if (stateHealth.status !== 'HEALTHY') {
      if (args.json)
        process.stdout.write(`${JSON.stringify({ ok: false, health: stateHealth })}\n`);
      else {
        process.stderr.write(
          stateHealth.status === 'ABSENT'
            ? `review ${args.sub}: review state is not initialized; run \`review data --branch ${args.branch}\` first\n`
            : `review ${args.sub}: ${stateHealth.status}: ${stateHealth.reason}; run \`review state repair --branch ${args.branch}\`\n`
        );
      }
      return 1;
    }
  }

  if (
    args.sub === 'semantic-anchor-submit' ||
    (args.sub !== undefined && (TWOLANE_RUN_VERBS as readonly string[]).includes(args.sub))
  ) {
    args.runtimeIdentity = await observeReviewExecutableIdentity(runtime, env);
  }

  if (args.sub === 'data') {
    if (!args.branch) {
      process.stderr.write('review data: --branch <branch> is required\n');
      return 1;
    }
    const branch = args.branch;
    // Sticky base: `--base auto` clears the branch's recorded
    // explicit base and re-derives fresh; any other explicit --base is
    // recorded after a successful build so a bare rerun cannot silently drift.
    let stickyBaseAction: StickyBaseAction | undefined;
    let effectiveBase = args.base;
    if (args.base === STICKY_BASE_AUTO_SENTINEL) {
      args.base = undefined;
      effectiveBase = undefined;
      stickyBaseAction = { kind: 'clear' };
    } else if (args.base !== undefined && args.base.length > 0) {
      const pinned = await runGit(root, ['rev-parse', '--verify', `${args.base}^{commit}`]);
      const pinnedSha = pinned.code === 0 ? pinned.stdout.toString('utf8').trim() : args.base;
      effectiveBase = pinnedSha;
      stickyBaseAction = { kind: 'set', branch, baseRef: args.base, pinnedSha };
    }
    const timings: ReviewDataStageTiming[] | null = env.ORCAOPS_REVIEW_TIMINGS === '1' ? [] : null;
    const timingStartedAt = timings === null ? 0 : performance.now();
    const recordTiming =
      timings === null
        ? undefined
        : (timing: ReviewDataStageTiming) => {
            timings.push({
              ...timing,
              duration_ms: roundTiming(timing.duration_ms),
            });
          };
    let floor: Floor;
    let assembled: AssembledFloor;
    try {
      assembled = await assembleOrReuseFloor(
        root,
        branch,
        effectiveBase,
        recordTiming,
        stickyBaseAction,
        args.rebuildCache === true
      );
      floor = assembled.floor;
    } catch (error) {
      if (error instanceof ReviewStateHealthError) {
        if (args.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, health: error.health })}\n`);
        } else {
          process.stderr.write(`review data: ${error.message}\n`);
        }
        return 1;
      }
      throw error;
    }

    if (timings !== null) {
      process.stderr.write(
        `review data timing: ${JSON.stringify({
          schema: 'orcaops.review-data-timing/v1',
          outcome: assembled.outcome,
          attempts: assembled.attempts,
          total_ms: roundTiming(performance.now() - timingStartedAt),
          stages: timings,
        })}\n`
      );
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(floor)}\n`);
    } else {
      const s = floor.coverage.summary;
      process.stdout.write(
        `floor: ${floor.scope.branch} · ${floor.scope.artifact_ids.length} artifact(s) · ` +
          `${s.matched_rows}/${s.reviewable_rows} rows matched · ${s.ambiguous_rows} ambiguous · ` +
          `${s.excluded} excluded / ${s.unreviewable} unreviewable hunk(s) · ` +
          `rung ${floor.attribution.active_rung}\n`
      );
    }
    return 0;
  }

  if (args.sub === 'ledger') {
    return runClaimLedger(args, root);
  }

  if (args.sub === 'dossier') {
    return runDossier(args, root);
  }

  if (args.sub === 'journal') {
    return runJournal(args, root, env);
  }

  if (args.sub === 'state') {
    return runDurableState(args, root);
  }

  if (args.sub === 'comments') {
    return runComments(args, root);
  }

  if (args.sub === 'comment') {
    return runCommentAction(args, root, env);
  }

  if (args.sub === 'anchor') {
    return runAnchor(args, root);
  }

  if (args.sub === 'semantic-anchor-submit') {
    return runSemanticAnchorSubmit(args, root);
  }

  if (args.sub === 'routine-start') {
    // Composite: floor assembly + routine dossier + run mint +
    // forensic serve in ONE host turn. Deterministic throughout. Every
    // failure path honors --json: the composite is driven by
    // automated callers, and a bare stderr line strands them without a
    // parseable envelope.
    if (!args.branch) return reviewVerbFailure(args, 'routine-start', '--branch is required', 2);
    try {
      await assembleOrReuseFloor(root, args.branch, args.base);
      await buildAndWriteDossier(root, args.branch, 'routine');
    } catch (error) {
      if (error instanceof ReviewStateHealthError) {
        if (args.json)
          process.stdout.write(`${JSON.stringify({ ok: false, health: error.health })}\n`);
        else process.stderr.write(`review routine-start: ${error.message}\n`);
        return 1;
      }
      if (error instanceof StubPolicyError || error instanceof ExcludePolicyError) {
        // Malformed repo stub or exclude policy: parseable envelope, no payload minted.
        if (args.json)
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: {
                verb: 'review routine-start',
                code: error.code,
                message: error.message,
                invalid_patterns: error.invalidPatterns,
              },
            })}\n`
          );
        else process.stderr.write(`review routine-start: ${error.message}\n`);
        return 1;
      }
      if (
        error instanceof AccountCorpusCeilingError ||
        error instanceof ForensicTransportCeilingError ||
        error instanceof ReviewDiffTruncatedError
      ) {
        // Size-degradation refusal: parseable envelope, no payload minted.
        if (args.json)
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: {
                verb: 'review routine-start',
                code: error.code,
                message: error.message,
                ceiling_bytes: error.ceilingBytes,
                actual_bytes: error.actualBytes,
              },
            })}\n`
          );
        else process.stderr.write(`review routine-start: ${error.message}\n`);
        return 1;
      }
      return reviewVerbFailure(args, 'routine-start', (error as Error).message, 1);
    }
    return runTwolaneRun(args, root);
  }

  if ((TWOLANE_RUN_VERBS as readonly string[]).includes(args.sub)) {
    return runTwolaneRun(args, root);
  }

  process.stderr.write(`review: unknown subcommand '${args.sub}'\n${REVIEW_USAGE}`);
  return 2;
}

// ---- whole-floor cache: the optimistic short-lock commit protocol ----

const FLOOR_JSON = 'floor.json';
const DIFF_PATCH = 'diff.patch';
const ATTRIBUTION_NDJSON = 'attribution.ndjson';
const FLOOR_CACHE_MARKER = 'floor-cache.json';
const MAX_BUILD_RETRIES = 3;

type ReviewDataStage =
  | 'scope_preamble'
  | 'cache_lookup'
  | 'build_total'
  | FloorBuildStage
  | 'recheck_install';

interface ReviewDataStageTiming {
  attempt: number;
  stage: ReviewDataStage;
  duration_ms: number;
}

interface AssembledFloor {
  floor: Floor;
  outcome: 'cache_hit' | 'built';
  attempts: number;
}

type StickyBaseAction =
  | { kind: 'clear' }
  | { kind: 'set'; branch: string; baseRef: string; pinnedSha: string };

function roundTiming(durationMs: number): number {
  return Math.round(durationMs * 1_000) / 1_000;
}

async function timeReviewDataStage<T>(
  onTiming: ((timing: ReviewDataStageTiming) => void) | undefined,
  attempt: number,
  stage: ReviewDataStage,
  run: () => T | Promise<T>
): Promise<T> {
  if (onTiming === undefined) return run();
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    onTiming({ attempt, stage, duration_ms: performance.now() - startedAt });
  }
}

/** Conventional lock directory for a repo's review writes (`ArtifactLock` mkdir-locks). */
export function reviewLocksDir(root: string): string {
  return path.join(root, '.orcaops', 'tmp', 'locks');
}

/** The per-review-slug lock key shared by the writer here and the reader in the TUI. */
export function reviewFloorLockKey(slug: string): string {
  return reviewStateLockKey(slug);
}

interface FloorCacheMarker {
  producerVersion: string;
  floorFingerprint: string;
}

/**
 * A HIT requires the marker present AND its producer version + fingerprint to
 * match AND floor.json to schema-parse (not merely JSON-parse — a shape drift
 * from an older engine must miss). Any failure returns null → the caller builds.
 */
async function readCachedFloor(dir: string, fingerprint: string): Promise<Floor | null> {
  let marker: FloorCacheMarker;
  try {
    marker = JSON.parse(
      await readFile(path.join(dir, FLOOR_CACHE_MARKER), 'utf8')
    ) as FloorCacheMarker;
  } catch {
    return null; // absent / unreadable / corrupt marker → miss
  }
  if (
    marker === null ||
    typeof marker !== 'object' ||
    marker.producerVersion !== FLOOR_PRODUCER_VERSION ||
    marker.floorFingerprint !== fingerprint
  ) {
    return null;
  }
  try {
    return floorSchema.parse(JSON.parse(await readFile(path.join(dir, FLOOR_JSON), 'utf8')));
  } catch {
    return null; // floor.json missing / torn / shape-invalid → miss
  }
}

/**
 * Serve a cache hit: refresh the live staleness anchor (`head_sha`) and the
 * generation stamp, rewrite floor.json, and re-pin the floor's trees so gc can't
 * prune them. MUST run inside the held lock — a rewrite after releasing could
 * clobber a newer generation another writer installs in between. The fingerprint
 * deliberately excludes worktreeHead, so a commit that advances HEAD without
 * changing the worktree tree is a HIT here, not a false "worktree moved" banner.
 * Passive staleness polling stays read-only; an explicit `review data` cache hit
 * may refresh the persisted anchor as the cached equivalent of a rebuild.
 */
async function serveCachedFloor(
  root: string,
  dir: string,
  cached: Floor,
  worktreeHead: string | null,
  now: string,
  verifyLease: () => Promise<void>
): Promise<Floor> {
  const refreshed: Floor = {
    ...cached,
    generated_at: now,
    scope: { ...cached.scope, head_sha: worktreeHead },
  };
  await verifyLease();
  await atomicWriteFile(path.join(dir, FLOOR_JSON), `${JSON.stringify(refreshed)}\n`, root);
  try {
    await pinReviewRefs(root, refreshed, verifyLease);
  } catch (error) {
    if (error instanceof ArtifactLockLeaseLostError) throw error;
    // silent: read time is the loud end of this contract
  }
  return refreshed;
}

/**
 * Install a freshly built bundle. Removes the OLD marker FIRST (so a crash
 * mid-write can't leave a stale marker blessing a partially-overwritten bundle),
 * writes the three files, pins refs, then writes the marker LAST and ONLY when
 * the build is healthy — marker presence is the commit record that the whole
 * bundle is consistent AND non-degraded. Must run inside the held lock.
 */
async function installFloor(
  root: string,
  dir: string,
  built: BuildFloorResult,
  fingerprint: string,
  healthy: boolean,
  verifyLease: () => Promise<void>
): Promise<void> {
  await verifyLease();
  await rm(path.join(dir, FLOOR_CACHE_MARKER), { force: true });
  // Compact JSON: a machine-read cache already multi-MB; pretty-printing doubles
  // it for no consumer. atomicWriteFile installs via temp+rename.
  await atomicWriteFile(path.join(dir, FLOOR_JSON), `${JSON.stringify(built.floor)}\n`, root);
  await atomicWriteFile(path.join(dir, DIFF_PATCH), built.reviewDiff, root);
  const ndjson = built.attributionLines.map((l) => JSON.stringify(l)).join('\n');
  await atomicWriteFile(
    path.join(dir, ATTRIBUTION_NDJSON),
    ndjson.length > 0 ? `${ndjson}\n` : '',
    root
  );
  // Persist the incremental blame cache (reused + newly computed entries). null
  // means "leave it untouched" — a disabled cache or a thrown lineage failure —
  // so a transient glitch never wipes accumulated entries. Independent of the
  // marker: even an unhealthy build's successful blame entries stay cached to
  // accelerate the retry.
  if (built.nextBlameCache !== null) {
    try {
      await saveBlameCache(dir, built.nextBlameCache, root);
    } catch {
      // The blame cache is a best-effort optimization; a failed write must never
      // fail review data or corrupt the already-installed floor bundle — the next
      // build simply recomputes. (The floor.json/diff.patch/attribution writes
      // above are the real output and are deliberately NOT swallowed.)
    }
  }
  try {
    await pinReviewRefs(root, built.floor, verifyLease);
  } catch (error) {
    if (error instanceof ArtifactLockLeaseLostError) throw error;
    // silent: read time is the loud end of this contract
  }
  if (healthy) {
    const marker: FloorCacheMarker = {
      producerVersion: FLOOR_PRODUCER_VERSION,
      floorFingerprint: fingerprint,
    };
    await verifyLease();
    await atomicWriteFile(path.join(dir, FLOOR_CACHE_MARKER), `${JSON.stringify(marker)}\n`, root);
  }
}

/**
 * Serve the review floor for a branch, reusing the on-disk cache when the inputs
 * are unchanged. Optimistic short-lock protocol: the expensive build runs OUTSIDE
 * the lock (the ArtifactLock is write-scoped, 10s acquire / 120s stale-reap — it
 * must never wrap long work); only the fingerprint hit-check and the bundle
 * install/serve are inside short critical sections. Duplicate build work under a
 * race is acceptable; cross-file bundle corruption is not.
 */
async function assembleOrReuseFloor(
  root: string,
  branch: string,
  base: string | undefined,
  onTiming?: (timing: ReviewDataStageTiming) => void,
  stickyBaseAction?: StickyBaseAction,
  rebuildCache = false
): Promise<AssembledFloor> {
  const lock = reviewLock(root, reviewLocksDir(root));
  const now = new Date().toISOString();
  let rebuildPending = rebuildCache;

  for (let attempt = 0; attempt < MAX_BUILD_RETRIES; attempt += 1) {
    // 1. Cheap candidate fingerprint from the preamble alone.
    const scopeInputs = await timeReviewDataStage(
      onTiming,
      attempt + 1,
      'scope_preamble',
      async () => {
        const result = await resolveScopeInputs({
          root,
          branch,
          base,
          ignoreStickyBase: stickyBaseAction?.kind === 'clear',
          rebuildCache: rebuildPending,
        });
        rebuildPending = false;
        return result;
      }
    );
    const slug = scopeInputs.input.branchSlug;
    const dir = reviewDirPath(root, slug);
    const key = reviewFloorLockKey(slug);
    const fingerprint = await computeFloorFingerprint(scopeInputs);

    // 2. Locked hit-check; serve (with the head_sha refresh) inside the lock.
    const hit = await timeReviewDataStage(onTiming, attempt + 1, 'cache_lookup', () =>
      lock.withLock(key, async (lease) => {
        // The version gate runs FIRST, before a single byte of the directory is
        // read. State written under a different REVIEW_STATE_VERSION is rejected
        // and never parsed. The explicit `review state repair` command deletes
        // incompatible state before initializing the current schema.
        await lease.verify();
        await ensureReviewStateVersion(dir, root);
        const cached = await readCachedFloor(dir, fingerprint);
        if (cached === null) return null;
        const floor = await serveCachedFloor(
          root,
          dir,
          cached,
          scopeInputs.input.worktreeHead,
          now,
          () => lease.verify()
        );
        await lease.verify();
        await applyStickyBaseAction(root, slug, stickyBaseAction);
        return floor;
      })
    );
    if (hit !== null) return { floor: hit, outcome: 'cache_hit', attempts: attempt + 1 };

    // 3. Miss → build OUTSIDE the lock (blame reuses the on-disk cache; the
    //    returned nextBlameCache is installed under the lock below).
    const built = await timeReviewDataStage(onTiming, attempt + 1, 'build_total', () =>
      buildFloor({
        root,
        branch,
        base,
        now,
        blameCacheDir: dir,
        scopeInputs,
        onStageTiming:
          onTiming === undefined
            ? undefined
            : (timing: FloorBuildStageTiming) => {
                onTiming({
                  attempt: attempt + 1,
                  stage: timing.stage,
                  duration_ms: timing.durationMs,
                });
              },
      })
    );
    const healthy = isFloorCacheHealthClean(built.cacheHealth);

    // 4+5. Reacquire, re-check for input drift and a concurrent install, commit.
    //   Compare the CURRENT inputs to the fingerprint the build ACTUALLY assembled
    //   over (built.fingerprint). buildFloor consumes the preamble snapshot, so a
    //   transient A→B→A move remains a safe A build; a current B still differs and
    //   retries. Install + serve under built.fingerprint so the marker can never
    //   disagree with the floor it commits.
    const outcome = await timeReviewDataStage(onTiming, attempt + 1, 'recheck_install', () =>
      lock.withLock<{ retry: true } | { floor: Floor }>(key, async (lease) => {
        await lease.verify();
        await ensureReviewStateVersion(dir, root);
        const recheck = await resolveScopeInputs({
          root,
          branch,
          base,
          ignoreStickyBase: stickyBaseAction?.kind === 'clear',
        });
        const recheckFingerprint = await computeFloorFingerprint(recheck);
        if (recheckFingerprint !== built.fingerprint) return { retry: true };
        const existing = await readCachedFloor(dir, built.fingerprint);
        let floor: Floor;
        if (existing === null) {
          await installFloor(root, dir, built, built.fingerprint, healthy, () => lease.verify());
          floor = built.floor;
        } else {
          floor = await serveCachedFloor(root, dir, existing, recheck.input.worktreeHead, now, () =>
            lease.verify()
          );
        }
        await lease.verify();
        await applyStickyBaseAction(root, slug, stickyBaseAction);
        return { floor };
      })
    );
    if ('retry' in outcome) continue;
    return { floor: outcome.floor, outcome: 'built', attempts: attempt + 1 };
  }
  throw new Error(
    `review data: inputs kept changing during the build for '${branch}' after ${MAX_BUILD_RETRIES} attempts`
  );
}

async function applyStickyBaseAction(
  root: string,
  branchSlug: string,
  action: StickyBaseAction | undefined
): Promise<void> {
  if (action === undefined) return;
  if (action.kind === 'clear') {
    await clearStickyBase(root, branchSlug);
    return;
  }
  await writeStickyBase(root, branchSlug, {
    schema_version: 1,
    branch: action.branch,
    baseRef: action.baseRef,
    pinnedSha: action.pinnedSha,
    recordedAt: new Date().toISOString(),
  });
}

/** `git update-ref <ref> <sha>` — replaces the ref (creating it if absent). */
async function updateRef(root: string, ref: string, sha: string): Promise<void> {
  const r = await runGit(root, ['update-ref', ref, sha]);
  if (r.code !== 0) throw new Error(`git update-ref ${ref} failed (${r.code}): ${r.stderr.trim()}`);
}

/**
 * Pin the floor's trees where `git gc` respects them. `pinned_tree_sha` is an
 * UNREACHABLE loose tree (captured with skipCommit) that gc prunes after ~2
 * weeks — but the TUI's gap expansion reads file blobs from it at interaction
 * time. Wrap it in a deterministic commit (commitTree pins fixed dates) at
 * `refs/orcaops/review/<slug>` — a COMMIT ref, not a tree ref, for parity with
 * the baseline-ref namespace so prune/for-each-ref treat all orcaops refs
 * identically (snapshots.ts records that rationale for baseline refs). The
 * base is usually a reachable merge-base commit, pinned as-is at
 * `<slug>-base`; the rare fallback where base_sha is a bare tree gets the same
 * commit wrap. Both refs are replaced on every `review data` run.
 */
async function pinReviewRefs(
  root: string,
  floor: Floor,
  verifyLease: () => Promise<void>
): Promise<void> {
  const slug = floor.scope.branch_slug;
  const ref = `refs/orcaops/review/${slug}`;
  const pin = await commitTree(
    root,
    floor.scope.pinned_tree_sha,
    null,
    `review-pin: ${slug} ${floor.generated_at}`
  );
  await verifyLease();
  await updateRef(root, ref, pin);

  const baseType = await runGit(root, ['cat-file', '-t', floor.scope.base_sha]);
  const kind = baseType.code === 0 ? baseType.stdout.toString('utf8').trim() : '';
  if (kind === 'commit') {
    await verifyLease();
    await updateRef(root, `${ref}-base`, floor.scope.base_sha);
  } else if (kind === 'tree') {
    const basePin = await commitTree(
      root,
      floor.scope.base_sha,
      null,
      `review-pin: ${slug}-base ${floor.generated_at}`
    );
    await verifyLease();
    await updateRef(root, `${ref}-base`, basePin);
  } else {
    // Unresolvable base: drop any stale pin rather than leave one pointing at
    // a previous run's base (delete of a missing ref exits 0).
    await verifyLease();
    await runGit(root, ['update-ref', '-d', `${ref}-base`]);
  }
}

export const REVIEW_USAGE = `usage: review <verb> --branch <b> [flags]
  data           derive + cache floor.json / diff.patch
                 --rebuild-cache explicitly rebuilds an older disposable cache
  anchor         mint code anchors + finding keys (--help for flags)
  semantic-anchor-submit  validate + install explicit non-adjudicating semantic associations
  ledger         build the deterministic claim ledger (account-vs-reality; no model)
  dossier        build the tier-1 deterministic dossier + lane inputs
  routine-start  floor + routine dossier + run mint + forensic input, one turn (optional --execution-profile-json)
  routine-submit validate a lane submission; acceptance serves the next input or finalizes
  start          mint a two-lane run from the built dossier outputs
  lane-input     serve one lane's immutable run input + payload contract
  lane-submit    validate one lane submission through the run state machine
  run-show       report run state: attempts, acceptance, repair credit
  finalize       merge accepted lanes, render review.md + brief, seal the run record
  journal        read/append reviewer disposition events
  state          health | repair for versioned durable review state
  comments       replayed comments + re-anchored positions
  comment        add | reply | resolve | reopen a comment

diagnostics:
  ORCAOPS_REVIEW_TIMINGS=1 review data ... emits one structured stage-timing record to stderr
`;
