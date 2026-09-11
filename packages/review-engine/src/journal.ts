// `review journal` — the reviewer disposition log.
//
//   review journal --branch <b> [--json]           read + replay → ledger JSON
//   review journal --branch <b> --add '<event>'    validate + append, then emit
//   review journal --branch <b> --add '[<event>,…]'  batch: all-or-nothing
//   review journal --branch <b> --input -          same, event JSON from stdin
//
// The journal is retained workflow rows (`journalEventSchema`). `--add` takes
// one event object, or a JSON array of events (the TUI's bulk acknowledgement)
// — a batch validates EVERY event before appending ANY, and the whole batch
// settles in one transaction, so a bad element can never leave a half-applied
// batch. `--input -` reads the SAME payload from stdin instead of argv — the
// transport for large events (a row-coverage manifest can exceed argv limits);
// validation, batch semantics and the emitted ledger are identical.
// Stdin is bounded by JOURNAL_STDIN_CAP_BYTES and an oversize payload is
// REJECTED loudly (nonzero exit, stderr names the cap) — never silently
// truncated. The append pins the floor, the selected Story and each event's own
// target to the exact revisions it read, so a concurrent write refuses as stale
// rather than crossing a check/use window.
// Reading replays the retained events into the derived last-writer-wins ledger
// the TUI renders and the mark-reviewed gate reads. A retained event that does
// not decode is an integrity refusal: no parsed prefix is replayed and no new
// event is appended over it, because a skipped event could hide an open
// obligation.
//
//   exit 0  ledger emitted (append, if requested, succeeded)
//   exit 1  usage / precondition error (no branch, bad event JSON, invalid
//           event, oversize stdin)

import {
  type CurrentThreadManifest,
  type Floor,
  type JournalEvent,
  journalEventSchema,
  replayReviewLedgerV2,
  type ReviewGenerationIdentity,
} from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';

import {
  applyDatabaseReviewWorkflow,
  readDatabaseReviewWorkflowEvents,
} from './database/workflow-command.js';
import {
  WORKFLOW_STALE_FLOOR_MESSAGE,
  WORKFLOW_STALE_LEDGER_MESSAGE,
  WORKFLOW_STALE_STORY_MESSAGE,
} from './database/workflow.js';
import { writeReviewError, writeReviewOutput } from './reviewFiles.js';
import { buildCurrentThreadManifests, buildEligibleNarrativeTargets } from './reviewTargets.js';
import type { ReviewArgs } from './run.js';

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
}

function rejected(code: JournalAppendRejectionCode, message: string): JournalAppendRejection {
  return { ok: false, code, message };
}

/**
 * Map a canonical refusal onto the journal's transport rejection codes. The
 * store's stale-precondition refusals are exactly the transport's stale-floor,
 * stale-story and stale-ledger cases; anything it cannot classify stays an
 * evidence mismatch rather than being reported as a healthy append.
 */
function journalRejection(error: unknown): JournalAppendRejection {
  const failure = error as { code?: string; message?: string };
  const message = failure.message ?? String(error);
  const code = failure.code;
  if (code === 'INVALID_INPUT')
    return rejected(JOURNAL_APPEND_REJECTION_CODE.INVALID_INPUT, message);
  // The store raises one code for every stale precondition, but the transport
  // publishes three: a caller that branches on a stale Story (Watch's
  // Story-read witness) must not be handed a stale floor instead. The three
  // aggregate refusals name themselves, so the sentence is the discriminator.
  if (code === 'STALE_PRECONDITION' || code === 'STALE_CONTEXT') {
    if (message === WORKFLOW_STALE_STORY_MESSAGE)
      return rejected(JOURNAL_APPEND_REJECTION_CODE.STALE_STORY, message);
    if (message === WORKFLOW_STALE_LEDGER_MESSAGE)
      return rejected(JOURNAL_APPEND_REJECTION_CODE.STALE_LEDGER, message);
    if (message === WORKFLOW_STALE_FLOOR_MESSAGE)
      return rejected(JOURNAL_APPEND_REJECTION_CODE.STALE_FLOOR, message);
    return rejected(JOURNAL_APPEND_REJECTION_CODE.STALE_FLOOR, message);
  }
  if (code === 'HISTORY_INTEGRITY_REQUIRED')
    return rejected(JOURNAL_APPEND_REJECTION_CODE.DURABLE_STATE_UNHEALTHY, message);
  if (
    code === 'REVIEW_NOT_FOUND' ||
    code === 'HISTORY_MISSING' ||
    code === 'PROJECT_IDENTITY_UNAVAILABLE'
  )
    return rejected(JOURNAL_APPEND_REJECTION_CODE.FLOOR_UNAVAILABLE, message);
  return rejected(JOURNAL_APPEND_REJECTION_CODE.EVIDENCE_MISMATCH, message);
}

function emitAppendRejection(
  args: ReviewArgs,
  flag: string,
  rejection: JournalAppendRejection
): void {
  if (args.json) {
    writeReviewError(`${JSON.stringify(rejection)}\n`);
    return;
  }
  writeReviewError(`review journal ${flag}: ${rejection.message}\n`);
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
    writeReviewError('review journal: --branch <branch> is required\n');
    return 1;
  }
  return runJournalLocked(args, root, env, stdin, hooks);
}

async function runJournalLocked(
  args: ReviewArgs,
  root: string,
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
  hooks: JournalRunHooks
): Promise<number> {
  // Append path: parse + validate the event(s) (the reason-gate lives in the
  // schema), then settle them before we read back. A JSON array is a batch —
  // validate ALL before appending ANY (all-or-nothing). The payload arrives via
  // argv (--add) or stdin (--input -); everything downstream of this resolution
  // is IDENTICAL for both transports.
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
    await hooks.afterLifecycleGenerationRead?.();
    try {
      await applyDatabaseReviewWorkflow({
        branch: args.branch!,
        cwd: root,
        operationId: args.operationId ?? uuidv7(),
        events,
        secretAllow: [],
      });
    } catch (error) {
      emitAppendRejection(args, flag, journalRejection(error));
      return 1;
    }
  }

  let replayEvents: JournalEvent[];
  let floor: Floor | null = null;
  let diffText: string | null = null;
  let storyGeneration: string | null = null;
  try {
    const retained = await readDatabaseReviewWorkflowEvents({ branch: args.branch!, cwd: root });
    replayEvents = retained.events;
    if (retained.context.floor !== null) {
      floor = retained.context.floor.floor as Floor;
      diffText = Buffer.from(retained.context.floor.diffBytes).toString('utf8');
    }
    // A Story sealed against a different floor is not the lens a reviewer could
    // have read over THIS floor, so it is absent from the lifecycle domain
    // rather than a stale generation the transport would still accept.
    if (retained.context.storyMatchesSelectedFloor === true)
      storyGeneration =
        retained.context.story?.publications.find((publication) => publication.kind === 'story')
          ?.generation ?? null;
  } catch (error) {
    const rejection = journalRejection(error);
    if (args.addEvent !== undefined || args.input !== undefined) {
      emitAppendRejection(args, args.input === undefined ? '--add' : '--input -', rejection);
    } else if (args.json) {
      writeReviewOutput(`${JSON.stringify({ ok: false, error: rejection })}\n`);
    } else {
      writeReviewError(`review journal: ${rejection.message}\n`);
    }
    return 1;
  }
  let currentThreads: CurrentThreadManifest[] = [];
  let currentGeneration: ReviewGenerationIdentity | null = null;
  if (floor !== null) {
    try {
      const eligibleTargets = await buildEligibleNarrativeTargets(floor, diffText!);
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
    currentGeneration = { floorInputHash: floor.input_hash, storyGeneration };
  }
  const replayed = await replayReviewLedgerV2({
    events: replayEvents,
    currentThreads,
    currentGeneration,
  });
  const { ledgerGeneration, ...ledger } = replayed;
  // Keep snake_case at the CLI wire boundary; Watch translates it once into
  // the shared ReviewLedgerV2 camel-case contract.
  writeReviewOutput(
    `${JSON.stringify({
      ...ledger,
      ledger_generation: ledgerGeneration,
    })}\n`
  );
  return 0;
}
