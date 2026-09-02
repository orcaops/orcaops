// `review journal` — the reviewer disposition log.
//
//   review journal --branch <b> [--json]           read + replay → ledger JSON
//   review journal --branch <b> --add '<event>'    validate + append, then emit
//   review journal --branch <b> --add '[<event>,…]'  batch: all-or-nothing
//   review journal --branch <b> --input -          same, event JSON from stdin
//
// The journal is `.orcaops/reviews/<slug>/journal.ndjson`, one JSON event per
// line (`journalEventSchema`). `--add` takes one event object, or a JSON array
// of events (the TUI's bulk acknowledgement) — a batch validates EVERY event
// before appending ANY, then lands under a single lock acquisition, so a bad
// element can never leave a half-applied batch in the log. `--input -` reads
// the SAME payload from stdin instead of argv — the transport for large
// events (a row-coverage manifest can exceed argv limits); validation,
// locking, batch semantics, mirroring, and the emitted ledger are identical.
// Stdin is bounded by JOURNAL_STDIN_CAP_BYTES and an oversize payload is
// REJECTED loudly (nonzero exit, stderr names the cap) — never silently
// truncated. Writes hold the branch review-state lock (floor + Story identity)
// and then `ArtifactLock.withLock(<slug>)` + `appendFile`, so publication cannot
// cross a lifecycle check/use window and journal writers never interleave a line.
// Reading validates the complete log before replaying it into the derived
// last-writer-wins ledger the TUI renders and the mark-reviewed gate reads. A
// malformed line fails closed: no parsed prefix is replayed and no new event is
// appended over it, because a skipped line could hide an open obligation.
//
//   exit 0  ledger emitted (append, if requested, succeeded)
//   exit 1  usage / precondition error (no branch, bad event JSON, invalid
//           event, oversize stdin)

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CITATION_KIND,
  type CurrentThreadManifest,
  describeFinishBlocker,
  evaluateFloorOnlyFinishGate,
  evaluateStoryFinishGate,
  FINDING_STATE,
  findingState,
  type FinishGateResult,
  type Floor,
  type FloorOnlyFinishGateInput,
  floorSchema,
  type JournalEvent,
  journalEventSchema,
  openReviewerCommentCount,
  PROMPT_STATE,
  replayComments,
  replayReviewLedgerV2,
  type ReviewedRow,
  reviewedRowsDigest,
  type ReviewGenerationIdentity,
  reviewLedgerGeneration,
  slugifyBranch,
  UNCERTAINTY_STATE,
  uncertaintyState,
} from '@orcaops/review-core';
import {
  appendDurable,
  ArtifactLock,
  type ArtifactLockLease,
  reviewEventIdentity,
} from '@orcaops/storage';

import { reviewArchiveMirror, type ReviewArchiveWarning } from './archive.js';
import { CURRENT_STORY_POINTER_FILE, resolveCurrentStory } from './currentStory.js';
import {
  DurableStateReadError,
  readCommentEventsStrict,
  readJournalEventsStrict,
} from './durableState.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath, reviewEntryPath } from './reviewPaths.js';
import {
  ensureReviewStateVersion,
  REVIEW_STATE_VERSION,
  ReviewStateHealthError,
  reviewStateLockKey,
} from './reviewState.js';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from './reviewTargets.js';
import type { ReviewArgs } from './run.js';
import type { StoryReviewModel } from './storyReviewModel.js';

interface JournalPaths {
  slug: string;
  dir: string;
  file: string;
  floorFile: string;
  diffFile: string;
  commentsFile: string;
  locksDir: string;
}

export const JOURNAL_APPEND_REJECTION_CODE = {
  INVALID_INPUT: 'INVALID_INPUT',
  DURABLE_STATE_UNHEALTHY: 'DURABLE_STATE_UNHEALTHY',
  FLOOR_UNAVAILABLE: 'FLOOR_UNAVAILABLE',
  STALE_FLOOR: 'STALE_FLOOR',
  STALE_STORY: 'STALE_STORY',
  STALE_LEDGER: 'STALE_LEDGER',
  EVIDENCE_MISMATCH: 'EVIDENCE_MISMATCH',
  STATE_CONFLICT: 'STATE_CONFLICT',
  GATE_BLOCKED: 'GATE_BLOCKED',
} as const;

export type JournalAppendRejectionCode =
  (typeof JOURNAL_APPEND_REJECTION_CODE)[keyof typeof JOURNAL_APPEND_REJECTION_CODE];

/** Narrow fault/barrier seam for proving the generation check/use critical section. */
export interface JournalRunHooks {
  afterLifecycleGenerationRead?: () => Promise<void>;
}

export interface JournalAppendRejection {
  ok: false;
  code: JournalAppendRejectionCode;
  message: string;
  warnings?: ReviewArchiveWarning[];
}

function rejected(code: JournalAppendRejectionCode, message: string): JournalAppendRejection {
  return { ok: false, code, message };
}

function emitAppendRejection(
  args: ReviewArgs,
  flag: string,
  rejection: JournalAppendRejection,
  warnings: readonly ReviewArchiveWarning[] = []
): void {
  const response = warnings.length === 0 ? rejection : { ...rejection, warnings: [...warnings] };
  if (args.json) {
    process.stderr.write(`${JSON.stringify(response)}\n`);
    return;
  }
  process.stderr.write(`review journal ${flag}: ${rejection.message}\n`);
  emitArchiveWarnings(warnings);
}

function emitArchiveWarnings(warnings: readonly ReviewArchiveWarning[]): void {
  for (const warning of warnings) process.stderr.write(`review archive: ${warning.message}\n`);
}

function journalPaths(root: string, branch: string): JournalPaths {
  const slug = slugifyBranch(branch);
  const dir = reviewDirPath(root, slug);
  return {
    slug,
    dir,
    file: path.join(dir, 'journal.ndjson'),
    floorFile: path.join(dir, 'floor.json'),
    diffFile: path.join(dir, 'diff.patch'),
    // Read (never written) by the finish gate. `review comments` locks on the
    // SAME slug, so reading it inside our lock is exclusive against any comment
    // write — and it is a plain read, so there is no nested lock to deadlock on.
    commentsFile: path.join(dir, 'comments.ndjson'),
    locksDir: path.join(root, '.orcaops', 'tmp', 'locks'),
  };
}

/**
 * The current lifecycle identity: the floor and the validated routine Story
 * selected by the engine-owned current pointer.
 */
async function readReviewGeneration(
  dir: string,
  floorFile: string
): Promise<ReviewGenerationIdentity> {
  const floor = floorSchema.parse(JSON.parse(await readFile(floorFile, 'utf8')));
  return {
    floorInputHash: floor.input_hash,
    storyGeneration: await readCurrentStoryGeneration(dir, floor.input_hash),
  };
}

/** ABSENT/STALE means floor-only; an invalid current state fails closed. */
async function readCurrentStoryGeneration(
  reviewDir: string,
  floorInputHash: string
): Promise<string | null> {
  return (await readCurrentStoryIdentity(reviewDir, floorInputHash)).generation;
}

interface CurrentStoryIdentity {
  generation: string | null;
  model: StoryReviewModel | null;
}

async function readCurrentStoryIdentity(
  reviewDir: string,
  floorInputHash: string
): Promise<CurrentStoryIdentity> {
  const resolved = await resolveCurrentStory({ reviewDir, floorInputHash });
  if (resolved.status === 'OK') {
    if (resolved.generation !== null && resolved.model !== null) {
      return { generation: resolved.generation, model: resolved.model };
    }
    throw new DurableStateReadError({
      kind: 'STORY',
      status: 'CORRUPT',
      path: path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE),
      reason: 'current Story resolver returned OK without a generation',
      schemaVersion: null,
    });
  }
  if (resolved.status === 'ABSENT' || resolved.status === 'STALE') {
    return { generation: null, model: null };
  }
  throw new DurableStateReadError({
    kind: 'STORY',
    status: 'CORRUPT',
    path: path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE),
    reason: resolved.issue ?? `current Story resolver returned ${resolved.status}`,
    schemaVersion: null,
  });
}

/**
 * Derive the finish gate's inputs FROM THE ENGINE'S OWN LOAD PATH and evaluate
 * the shared core gate over them.
 *
 * The point is that nothing here is taken from the caller. Watch computes these
 * same facts from its own load path and calls the same `evaluateFloorOnlyFinishGate`;
 * if the two ever disagreed, the transport's answer is the one that lands, and a
 * COMPLETE stops being only as true as the reader that sent it.
 */
async function evaluateFinishGateAt(
  paths: JournalPaths,
  floor: Floor,
  existingEvents: readonly JournalEvent[],
  story: StoryReviewModel | null
): Promise<FinishGateResult> {
  let targets: FloorOnlyFinishGateInput['targets'] = { ok: true };
  let currentThreads: CurrentThreadManifest[] = floor.outline.threads.map((thread) => ({
    threadKey: thread.threadKey,
    rows: null,
    digest: null,
  }));
  let currentGapRows: ReviewedRow[] = [];
  try {
    const diffText = await readFile(paths.diffFile, 'utf8');
    const eligibleTargets = await buildEligibleNarrativeTargets(floor, diffText);
    currentThreads = await buildCurrentThreadManifests(floor, eligibleTargets);
    currentGapRows = await buildCurrentGapRows(floor, diffText);
  } catch (cause) {
    targets = { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }

  const ledger = await replayReviewLedgerV2({ events: existingEvents, currentThreads });
  const comments = replayComments(await readCommentEventsStrict(paths.commentsFile));

  const floorGate = evaluateFloorOnlyFinishGate({
    targets,
    currentThreads,
    coverage: ledger.coverage,
    currentGapRows,
    inspectedGapRows: ledger.unassigned.gapRows,
    currentAmbiguousHunkKeys: floor.outline.unassigned.ambiguous.hunkKeys,
    inspectedAmbiguousHunkKeys: ledger.unassigned.ambiguousHunkKeys,
    openReviewerComments: openReviewerCommentCount(comments),
    // A captured uncertainty is a floor citation; with no journal event it is
    // OPEN. No narrative is involved in either half of that.
    openUncertaintyCitationIds: floor.citations
      .filter((citation) => citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY)
      .map((citation) => citation.id)
      .filter((id) => uncertaintyState(ledger, id) === UNCERTAINTY_STATE.OPEN),
  });
  if (story === null) return floorGate;

  const openRequiredStoryItems =
    story.findings.filter(
      (finding) => finding.required && findingState(ledger, finding.id) === FINDING_STATE.OPEN
    ).length +
    story.questions.filter(
      (question) =>
        question.required &&
        (ledger.prompts.find((entry) => entry.promptKey === question.id)?.state ??
          PROMPT_STATE.OPEN) === PROMPT_STATE.OPEN
    ).length;
  return evaluateStoryFinishGate({ floor: floorGate, openRequiredStoryItems });
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

/**
 * Upper bound on the stdin payload for `--input -`. Generous — a manifest for
 * a very large review is single-digit MB — but explicit: an oversize payload
 * fails LOUDLY (exit 1, the cap named on stderr) rather than being truncated
 * into a half-parsed event.
 */
export const JOURNAL_STDIN_CAP_BYTES = 64 * 1024 * 1024;

/** Accumulate stdin up to `cap` bytes; `ok: false` the moment the cap is crossed. */
async function readStdinCapped(
  stream: NodeJS.ReadableStream,
  cap: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    total += buf.length;
    if (total > cap) return { ok: false };
    chunks.push(buf);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Resolve the raw event JSON to append: `--add <json>` from argv, or
 * `--input -` from stdin (the large-payload transport). Returns null for the
 * pure read path; `{ error }` for a usage violation or an over-cap stdin.
 */
async function resolveAddPayload(
  args: ReviewArgs,
  stdin: NodeJS.ReadableStream
): Promise<{ raw: string; flag: string } | { error: string } | null> {
  if (args.addEvent !== undefined && args.input !== undefined) {
    return { error: 'review journal: pass either --add <json> or --input -, not both' };
  }
  if (args.addEvent !== undefined) return { raw: args.addEvent, flag: '--add' };
  if (args.input !== undefined) {
    if (args.input !== '-') {
      return {
        error: "review journal --input: only '-' (read the event JSON from stdin) is supported",
      };
    }
    const read = await readStdinCapped(stdin, JOURNAL_STDIN_CAP_BYTES);
    if (!read.ok) {
      return {
        error: `review journal --input -: stdin exceeds the ${JOURNAL_STDIN_CAP_BYTES / (1024 * 1024)}MB cap (${JOURNAL_STDIN_CAP_BYTES} bytes) — nothing appended`,
      };
    }
    return { raw: read.text, flag: '--input -' };
  }
  return null;
}

/** Run `review journal`. Returns the process exit code. */
export async function runJournal(
  args: ReviewArgs,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin,
  hooks: JournalRunHooks = {}
): Promise<number> {
  if (!args.branch) {
    process.stderr.write('review journal: --branch <branch> is required\n');
    return 1;
  }
  const paths = journalPaths(root, args.branch);
  const lock = reviewLock(root, paths.locksDir);
  try {
    return await lock.withLock(reviewStateLockKey(paths.slug), async (stateLease) => {
      await stateLease.verify();
      await ensureReviewStateVersion(paths.dir, root);
      return runJournalLocked(args, root, env, stdin, paths, lock, stateLease, hooks);
    });
  } catch (error) {
    if (error instanceof ReviewStateHealthError) {
      const rejection = rejected(
        JOURNAL_APPEND_REJECTION_CODE.DURABLE_STATE_UNHEALTHY,
        `${error.message}; repair deletes the complete review directory and initializes empty current state`
      );
      if (args.addEvent !== undefined || args.input !== undefined) {
        emitAppendRejection(args, args.input === undefined ? '--add' : '--input -', rejection);
      } else if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            health: {
              kind: 'REVIEW_STATE',
              status: error.health.status,
              path: error.health.path,
              reason: error.health.reason,
              schemaVersion: 'version' in error.health ? error.health.version : null,
              currentVersion: REVIEW_STATE_VERSION,
            },
          })}\n`
        );
      } else {
        process.stderr.write(`review journal: ${rejection.message}\n`);
      }
      return 1;
    }
    throw error;
  }
}

async function runJournalLocked(
  args: ReviewArgs,
  root: string,
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
  paths: JournalPaths,
  lock: ArtifactLock,
  stateLease: ArtifactLockLease,
  hooks: JournalRunHooks
): Promise<number> {
  const { slug, dir, file, floorFile, diffFile } = paths;
  let archiveWarnings: ReviewArchiveWarning[] = [];

  // Append path: parse + validate the event(s) (the reason-gate lives in the
  // schema), then append under the per-slug lock before we read back. A JSON
  // array is a batch — validate ALL before appending ANY (all-or-nothing).
  // The payload arrives via argv (--add) or stdin (--input -); everything
  // downstream of this resolution is IDENTICAL for both transports.
  const payload = await resolveAddPayload(args, stdin);
  if (payload !== null && 'error' in payload) {
    emitAppendRejection(
      args,
      '--input -',
      rejected(JOURNAL_APPEND_REJECTION_CODE.INVALID_INPUT, payload.error)
    );
    return 1;
  }
  if (payload !== null) {
    const flag = payload.flag;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.raw);
    } catch {
      emitAppendRejection(
        args,
        flag,
        rejected(JOURNAL_APPEND_REJECTION_CODE.INVALID_INPUT, 'event is not valid JSON')
      );
      return 1;
    }
    const isBatch = Array.isArray(parsed);
    const candidates: unknown[] = isBatch ? (parsed as unknown[]) : [parsed];
    if (candidates.length === 0) {
      emitAppendRejection(
        args,
        flag,
        rejected(
          JOURNAL_APPEND_REJECTION_CODE.INVALID_INPUT,
          'event array is empty — nothing to append'
        )
      );
      return 1;
    }
    const events: JournalEvent[] = [];
    for (const [i, candidate] of candidates.entries()) {
      const result = journalEventSchema.safeParse(candidate);
      if (!result.success) {
        const at = isBatch ? ` at index ${i}` : '';
        const tail = isBatch ? ' — nothing appended' : '';
        emitAppendRejection(
          args,
          flag,
          rejected(
            JOURNAL_APPEND_REJECTION_CODE.INVALID_INPUT,
            `invalid event${at} (${issues(result.error)})${tail}`
          )
        );
        return 1;
      }
      events.push(result.data);
    }
    const coverageEvents = events.filter((event) => event.type === 'review_coverage');
    const lifecycleEvents = events.filter((event) => event.type === 'review_lifecycle');
    if ((coverageEvents.length > 0 || lifecycleEvents.length > 0) && events.length !== 1) {
      emitAppendRejection(
        args,
        flag,
        rejected(
          JOURNAL_APPEND_REJECTION_CODE.INVALID_INPUT,
          'generation-guarded review events must be the one atomic event in their append — nothing appended'
        )
      );
      return 1;
    }
    // Resolve the archive mirror BEFORE the lock (its config/git reads must not
    // widen the critical section); null when the archive is disabled/absent.
    const archive = await reviewArchiveMirror(root, env);
    const mirror = archive.mirror;
    archiveWarnings = archive.warnings;
    // One serialized line per event; a single appendFile for the whole batch
    // under one lock (a crash costs the tail of this write, never an
    // interleaved or half-validated log).
    const rawLines = events.map((e) => JSON.stringify(e));
    const appendResult = await lock.withLock<{ ok: true } | JournalAppendRejection>(
      slug,
      async (slugLease) => {
        const coverage = coverageEvents[0];
        const lifecycle = lifecycleEvents[0];
        let existingEvents: JournalEvent[];
        try {
          existingEvents = await readJournalEventsStrict(file);
        } catch (error) {
          if (error instanceof DurableStateReadError) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.DURABLE_STATE_UNHEALTHY,
              `${error.message} — nothing appended`
            );
          }
          throw error;
        }
        if (coverage?.type === 'review_coverage') {
          let floorInputHash: string;
          let floorSectionKeys: Set<string>;
          try {
            const floor = floorSchema.parse(JSON.parse(await readFile(floorFile, 'utf8')));
            floorInputHash = floor.input_hash;
            floorSectionKeys = new Set(floor.outline.threads.map((thread) => thread.threadKey));
          } catch {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.FLOOR_UNAVAILABLE,
              'RECORD_REVIEW_COVERAGE requires a valid current floor.json — run `review data` and retry'
            );
          }
          if (floorInputHash !== coverage.floor_input_hash) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.STALE_FLOOR,
              `stale floor generation (${coverage.floor_input_hash} != ${floorInputHash}) — nothing appended; refresh and retry`
            );
          }
          for (const thread of coverage.threads) {
            if (!floorSectionKeys.has(thread.threadKey)) {
              return rejected(
                JOURNAL_APPEND_REJECTION_CODE.EVIDENCE_MISMATCH,
                `unknown floor thread ${thread.threadKey} — nothing appended; refresh and retry`
              );
            }
            if ((await reviewedRowsDigest(thread.coveredRows)) !== thread.coveredRowsDigest) {
              return rejected(
                JOURNAL_APPEND_REJECTION_CODE.EVIDENCE_MISMATCH,
                `coveredRowsDigest mismatch for ${thread.threadKey} — nothing appended`
              );
            }
            if (
              thread.completedRows !== undefined &&
              (await reviewedRowsDigest(thread.completedRows)) !== thread.completedRowsDigest
            ) {
              return rejected(
                JOURNAL_APPEND_REJECTION_CODE.EVIDENCE_MISMATCH,
                `completedRowsDigest mismatch for ${thread.threadKey} — nothing appended`
              );
            }
          }
          const currentGeneration = await reviewLedgerGeneration(existingEvents);
          if (currentGeneration !== coverage.ledger_generation) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.STALE_LEDGER,
              `stale ledger generation (${coverage.ledger_generation} != ${currentGeneration}) — nothing appended; refresh and retry`
            );
          }
        }
        if (lifecycle?.type === 'review_lifecycle') {
          let floor: Floor;
          try {
            floor = floorSchema.parse(JSON.parse(await readFile(floorFile, 'utf8')));
          } catch (cause) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.FLOOR_UNAVAILABLE,
              `review lifecycle requires a valid current floor.json (${cause instanceof Error ? cause.message : String(cause)}) — nothing appended; run \`review data\` and retry`
            );
          }
          let currentStory: CurrentStoryIdentity;
          try {
            currentStory = await readCurrentStoryIdentity(dir, floor.input_hash);
          } catch (error) {
            if (error instanceof DurableStateReadError) {
              return rejected(
                JOURNAL_APPEND_REJECTION_CODE.DURABLE_STATE_UNHEALTHY,
                `${error.message} — nothing appended`
              );
            }
            throw error;
          }
          const currentStoryGeneration = currentStory.generation;
          await hooks.afterLifecycleGenerationRead?.();
          if (lifecycle.floor_input_hash !== floor.input_hash) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.STALE_FLOOR,
              `stale floor generation (${lifecycle.floor_input_hash} != ${floor.input_hash}) — nothing appended; refresh and retry`
            );
          }
          // The basis is a claim about what the reviewer READ, so the transport
          // checks it against the validated current Story. A FLOOR_ONLY finish
          // raced by a Story landing mid-review is not a floor-only finish.
          if (lifecycle.story_generation !== currentStoryGeneration) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.STALE_STORY,
              currentStoryGeneration === null
                ? 'this review has no valid current Story, but the lifecycle event pins one — nothing appended; refresh and retry'
                : lifecycle.story_generation === null
                  ? 'a valid Story is now installed, so this review is no longer floor-only — nothing appended; refresh and retry'
                  : `stale Story generation (${lifecycle.story_generation} != ${currentStoryGeneration}) — nothing appended; refresh and retry`
            );
          }
          const currentLedgerGeneration = await reviewLedgerGeneration(existingEvents);
          if (lifecycle.ledger_generation !== currentLedgerGeneration) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.STALE_LEDGER,
              `stale ledger generation (${lifecycle.ledger_generation} != ${currentLedgerGeneration}) — nothing appended; refresh and retry`
            );
          }
          const latestLifecycle = existingEvents
            .filter((event) => event.type === 'review_lifecycle')
            .at(-1);
          const isOpen = latestLifecycle === undefined || latestLifecycle.action === 'REOPEN';
          if (lifecycle.action === 'REOPEN' ? isOpen : !isOpen) {
            return rejected(
              JOURNAL_APPEND_REJECTION_CODE.STATE_CONFLICT,
              lifecycle.action === 'REOPEN'
                ? 'review lifecycle is already open — nothing appended'
                : 'review lifecycle is already finished — reopen it before finishing again; nothing appended'
            );
          }
          // THE CANONICAL GATE, RE-CHECKED HERE. This transport
          // does not independently enforce Watch's completion model — it took
          // Watch's word for it, so a COMPLETE was only ever as true as the
          // reader that sent it. These obligations are facts about the floor and
          // the ledger, so they hold under EITHER lens: the Story adds
          // obligations (items, disclosures) on top, it never removes these.
          if (lifecycle.action === 'COMPLETE') {
            let gate: FinishGateResult;
            try {
              gate = await evaluateFinishGateAt(paths, floor, existingEvents, currentStory.model);
            } catch (error) {
              if (error instanceof DurableStateReadError) {
                return rejected(
                  JOURNAL_APPEND_REJECTION_CODE.DURABLE_STATE_UNHEALTHY,
                  `${error.message} — nothing appended`
                );
              }
              throw error;
            }
            if (!gate.allowed) {
              return rejected(
                JOURNAL_APPEND_REJECTION_CODE.GATE_BLOCKED,
                `review is not finishable: ${gate.blockers.map(describeFinishBlocker).join('; ')} — nothing appended`
              );
            }
          }
        }
        await stateLease.verify();
        await slugLease.verify();
        await appendDurable(
          reviewEntryPath(root, file, 'review journal'),
          rawLines.map((l) => `${l}\n`).join(''),
          root
        );
        // Hot first, mirror second, fail-open: the archive copy of each
        // just-appended line lands under the SAME slug lock (hot-lock →
        // archive-lock order). A null mirror makes this a complete no-op and the
        // behavior is byte-unchanged from an archive-disabled repo.
        if (mirror) {
          for (const raw of rawLines) {
            await mirror.mirrorReviewEvent(
              REVIEW_STATE_VERSION,
              slug,
              'journal',
              raw,
              reviewEventIdentity(raw)
            );
          }
        }
        return { ok: true };
      }
    );
    if (!appendResult.ok) {
      emitAppendRejection(args, flag, appendResult, archiveWarnings);
      return 1;
    }
  }

  let replayEvents: JournalEvent[];
  try {
    replayEvents = await readJournalEventsStrict(file);
  } catch (error) {
    if (error instanceof DurableStateReadError) {
      if (args.addEvent !== undefined || args.input !== undefined) {
        emitAppendRejection(
          args,
          args.input === undefined ? '--add' : '--input -',
          rejected(
            JOURNAL_APPEND_REJECTION_CODE.DURABLE_STATE_UNHEALTHY,
            `${error.message} — append outcome requires inspection`
          ),
          archiveWarnings
        );
      } else if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, health: error.health })}\n`);
      } else {
        process.stderr.write(`review journal: ${error.message}\n`);
      }
      return 1;
    }
    throw error;
  }
  let currentThreads: CurrentThreadManifest[] = [];
  let currentGeneration: Awaited<ReturnType<typeof readReviewGeneration>> | null = null;
  try {
    const floor = floorSchema.parse(JSON.parse(await readFile(floorFile, 'utf8')));
    try {
      const diffText = await readFile(diffFile, 'utf8');
      const eligibleTargets = await buildEligibleNarrativeTargets(floor, diffText);
      currentThreads = await buildCurrentThreadManifests(floor, eligibleTargets);
    } catch {
      // Fail closed while the current manifests are unavailable. Preserve one
      // checking entry per thread so legacy marks cannot become false review.
      currentThreads = floor.outline.threads.map((thread) => ({
        threadKey: thread.threadKey,
        rows: null,
        digest: null,
      }));
    }
  } catch {
    currentThreads = [];
  }
  try {
    currentGeneration = await readReviewGeneration(dir, floorFile);
  } catch {
    currentGeneration = null;
  }
  const replayed = await replayReviewLedgerV2({
    events: replayEvents,
    currentThreads,
    currentGeneration,
  });
  const { ledgerGeneration, ...ledger } = replayed;
  // Keep snake_case at the CLI wire boundary; Watch translates it once into
  // the shared ReviewLedgerV2 camel-case contract.
  process.stdout.write(
    `${JSON.stringify({
      ...ledger,
      ledger_generation: ledgerGeneration,
      ...(archiveWarnings.length > 0 ? { warnings: archiveWarnings } : {}),
    })}\n`
  );
  if (!args.json) emitArchiveWarnings(archiveWarnings);
  return 0;
}
