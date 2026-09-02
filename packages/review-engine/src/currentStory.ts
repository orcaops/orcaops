// Authoritative installation and resolution of the routine Story lens.
//
// A model hash is content identity; it cannot select which finalized run is
// current. Finalization therefore publishes one branch-wide pointer after the
// run record and run state are terminal. Readers validate that pointer all the
// way through to the model bytes and never fall back to an older run.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { slugifyBranch } from '@orcaops/review-core';
import { atomicWriteFile } from '@orcaops/storage';

import { reviewLock } from './reviewLock.js';
import { reviewEntryPath } from './reviewPaths.js';
import { reviewStateLockKey } from './reviewState.js';
import {
  parseStoryReviewModel,
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  storyReviewGeneration,
  type StoryReviewModel,
} from './storyReviewModel.js';
import { readTwolaneRunFile, TWOLANE_RUN_RECORD_SCHEMA_VERSION } from './twolaneRunFile.js';

export const CURRENT_STORY_POINTER_SCHEMA_VERSION = 1;
export const CURRENT_STORY_POINTER_FILE = 'current-story-v1.json';
export const CURRENT_STORY_INSTALL_FAILED = 'CURRENT_STORY_INSTALL_FAILED';

const RUN_RECORD_FILE = 'run-record-v1.json';

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const outcomeSchema = z.enum(['FULL', 'DEGRADED', 'FAILED']);

export const currentStoryPointerSchema = z
  .object({
    schema_version: z.literal(CURRENT_STORY_POINTER_SCHEMA_VERSION),
    run_id: z.string().uuid(),
    finalized_at: z.string().datetime(),
    floor_input_hash: z.string().min(1),
    model_file: z.literal(STORY_REVIEW_MODEL_FILE),
    model_sha256: sha256Schema,
  })
  .strict();

export type CurrentStoryPointer = z.infer<typeof currentStoryPointerSchema>;

// The run file itself parses through the strict persisted schema
// (readTwolaneRunFile); this partial schema reads only the SEPARATE run-record
// file, whose full shape is owned by the finalize writer.
const terminalRunRecordSchema = z
  .object({
    schema_version: z.literal(TWOLANE_RUN_RECORD_SCHEMA_VERSION),
    run_id: z.string().min(1),
    branch: z.string(),
    input_shas: z.record(z.string(), z.string()),
    finalized_at: z.string().datetime(),
    outcome: outcomeSchema,
    outputs: z
      .object({
        story_review_model: z.literal(STORY_REVIEW_MODEL_FILE),
        story_review_model_sha256: sha256Schema,
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export type CurrentStoryStatus = 'OK' | 'ABSENT' | 'STALE' | 'INVALID';

interface CurrentStoryResultBase {
  status: CurrentStoryStatus;
  runId: string | null;
  generation: string | null;
  model: StoryReviewModel | null;
  issue: string | null;
  pointerSha256: string | null;
  modelSha256: string | null;
}

export type CurrentStoryResolution = CurrentStoryResultBase;

const result = (
  status: CurrentStoryStatus,
  partial: Partial<Omit<CurrentStoryResultBase, 'status'>> = {}
): CurrentStoryResolution => ({
  status,
  runId: partial.runId ?? null,
  generation: partial.generation ?? null,
  model: partial.model ?? null,
  issue: partial.issue ?? null,
  pointerSha256: partial.pointerSha256 ?? null,
  modelSha256: partial.modelSha256 ?? null,
});

const safeRunId = (runId: string): boolean =>
  runId !== '.' &&
  runId !== '..' &&
  path.basename(runId) === runId &&
  !runId.includes('/') &&
  !runId.includes('\\');

function runDirBeneath(twolaneDir: string, runId: string): string {
  if (!safeRunId(runId)) throw new Error(`current Story run_id is unsafe: ${runId}`);
  const root = path.resolve(twolaneDir);
  const runDir = path.resolve(root, runId);
  if (path.dirname(runDir) !== root)
    throw new Error(`current Story run_id escapes the two-lane root: ${runId}`);
  return runDir;
}

interface ValidatedRun {
  pointer: CurrentStoryPointer;
  pointerBytes: string;
  model: StoryReviewModel;
  modelBytes: string;
  runDir: string;
  generation: string;
}

const canonicalRecord = (record: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    )
  );

async function validatePointedRun(input: {
  twolaneDir: string;
  pointer: CurrentStoryPointer;
  pointerBytes: string;
}): Promise<ValidatedRun> {
  const runDir = runDirBeneath(input.twolaneDir, input.pointer.run_id);
  const [run, recordRaw, modelBytes] = await Promise.all([
    readTwolaneRunFile(runDir),
    readFile(path.join(runDir, RUN_RECORD_FILE), 'utf8'),
    readFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), 'utf8'),
  ]);
  const record = terminalRunRecordSchema.parse(JSON.parse(recordRaw));
  if (run.finalized === null) throw new Error('current Story run is not terminal');
  if (
    run.run_id !== input.pointer.run_id ||
    record.run_id !== input.pointer.run_id ||
    run.branch !== record.branch ||
    canonicalRecord(run.input_shas) !== canonicalRecord(record.input_shas)
  )
    throw new Error('current Story pointer, run, and run record identities disagree');
  if (
    run.finalized.at !== record.finalized_at ||
    run.finalized.outcome !== record.outcome ||
    input.pointer.finalized_at !== record.finalized_at
  )
    throw new Error('current Story terminal run and run record disagree');
  if (record.outcome === 'FAILED' || record.outputs === null)
    throw new Error('failed run cannot install a current Story');
  const modelSha256 = sha256(modelBytes);
  if (
    modelSha256 !== input.pointer.model_sha256 ||
    modelSha256 !== record.outputs.story_review_model_sha256
  )
    throw new Error('current Story model bytes do not match the pointer hash');
  const model = parseStoryReviewModel(JSON.parse(modelBytes));
  if (model.branch !== run.branch || model.floor_input_hash !== input.pointer.floor_input_hash)
    throw new Error('current Story model identity disagrees with its terminal run pointer');
  // Producers install canonical bytes. Requiring that form makes generation
  // reproducible across readers and catches hand-edited/copied installations.
  if (serializeStoryReviewModel(model) !== modelBytes)
    throw new Error('current Story model bytes are not canonical v4 serialization');
  return {
    pointer: input.pointer,
    pointerBytes: input.pointerBytes,
    model,
    modelBytes,
    runDir,
    generation: await storyReviewGeneration(model),
  };
}

/**
 * Resolve exactly one authoritative Story installation. Invalid current state
 * is visible and never causes a search for another run.
 */
export async function resolveCurrentStory(input: {
  reviewDir: string;
  floorInputHash?: string;
}): Promise<CurrentStoryResolution> {
  const twolaneDir = path.join(input.reviewDir, 'twolane');
  const pointerFile = path.join(twolaneDir, CURRENT_STORY_POINTER_FILE);
  let pointerBytes: string;
  try {
    pointerBytes = await readFile(pointerFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return result('INVALID', {
        issue: `CURRENT_STORY_POINTER_UNREADABLE: ${(error as Error).message}`,
      });
    return result('ABSENT');
  }

  const pointerSha256 = sha256(pointerBytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(pointerBytes);
  } catch (error) {
    return result('INVALID', {
      issue: `CURRENT_STORY_POINTER_INVALID: ${(error as Error).message}`,
      pointerSha256,
    });
  }
  const parsedPointer = currentStoryPointerSchema.safeParse(decoded);
  if (!parsedPointer.success)
    return result('INVALID', {
      runId:
        decoded !== null && typeof decoded === 'object' && 'run_id' in decoded
          ? String((decoded as { run_id: unknown }).run_id)
          : null,
      issue: `CURRENT_STORY_POINTER_INVALID: ${parsedPointer.error.message}`,
      pointerSha256,
    });
  try {
    const validated = await validatePointedRun({
      twolaneDir,
      pointer: parsedPointer.data,
      pointerBytes,
    });
    const modelSha256 = sha256(validated.modelBytes);
    if (
      input.floorInputHash !== undefined &&
      validated.model.floor_input_hash !== input.floorInputHash
    )
      return result('STALE', {
        runId: validated.pointer.run_id,
        generation: validated.generation,
        // The model passed full validation BEFORE the floor comparison; only
        // its floor moved. Expose it so a viewer can project it best-effort —
        // consumers gate authority on status, never on model presence.
        model: validated.model,
        issue: `STALE_STORY: installed floor ${validated.model.floor_input_hash} does not match current floor ${input.floorInputHash}`,
        pointerSha256,
        modelSha256,
      });
    return result('OK', {
      runId: validated.pointer.run_id,
      generation: validated.generation,
      model: validated.model,
      pointerSha256,
      modelSha256,
    });
  } catch (error) {
    return result('INVALID', {
      runId: parsedPointer.data.run_id,
      issue: `CURRENT_STORY_INVALID: ${(error as Error).message}`,
      pointerSha256,
    });
  }
}

function tupleCompare(
  left: Pick<CurrentStoryPointer, 'finalized_at' | 'run_id'>,
  right: Pick<CurrentStoryPointer, 'finalized_at' | 'run_id'>
): number {
  const leftInstant = Date.parse(left.finalized_at);
  const rightInstant = Date.parse(right.finalized_at);
  if (leftInstant !== rightInstant) return leftInstant < rightInstant ? -1 : 1;
  return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
}

async function pointerForTerminalRun(input: {
  twolaneDir: string;
  branch: string;
  runId: string;
}): Promise<CurrentStoryPointer> {
  const runDir = runDirBeneath(input.twolaneDir, input.runId);
  const [run, recordRaw, modelBytes] = await Promise.all([
    readTwolaneRunFile(runDir),
    readFile(path.join(runDir, RUN_RECORD_FILE), 'utf8'),
    readFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), 'utf8'),
  ]);
  const record = terminalRunRecordSchema.parse(JSON.parse(recordRaw));
  if (
    run.finalized === null ||
    run.run_id !== input.runId ||
    record.run_id !== input.runId ||
    run.branch !== record.branch ||
    run.branch !== input.branch ||
    canonicalRecord(run.input_shas) !== canonicalRecord(record.input_shas) ||
    run.finalized.at !== record.finalized_at ||
    run.finalized.outcome !== record.outcome ||
    record.outcome === 'FAILED' ||
    record.outputs === null
  )
    throw new Error('run is not a coherent terminal Story run');
  const model = parseStoryReviewModel(JSON.parse(modelBytes));
  if (serializeStoryReviewModel(model) !== modelBytes)
    throw new Error('terminal Story model is not canonical v4 serialization');
  if (model.branch !== run.branch)
    throw new Error('terminal Story model branch does not match the run');
  const modelSha256 = sha256(modelBytes);
  if (record.outputs.story_review_model_sha256 !== modelSha256)
    throw new Error('terminal Story model hash does not match the run record');
  return currentStoryPointerSchema.parse({
    schema_version: CURRENT_STORY_POINTER_SCHEMA_VERSION,
    run_id: input.runId,
    finalized_at: record.finalized_at,
    floor_input_hash: model.floor_input_hash,
    model_file: STORY_REVIEW_MODEL_FILE,
    model_sha256: modelSha256,
  });
}

export interface PublishCurrentStoryResult {
  pointer: CurrentStoryPointer;
  installed: boolean;
}

export class CurrentStoryInstallError extends Error {
  readonly code = CURRENT_STORY_INSTALL_FAILED;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CurrentStoryInstallError';
  }
}

/**
 * Publish (or repair) the branch-wide pointer under its own lock. A newer valid
 * pointer always wins; an invalid/missing pointer is repaired by the candidate.
 */
export async function publishCurrentStoryForRun(input: {
  reviewDir: string;
  locksDir: string;
  containmentRoot: string;
  branch: string;
  runId: string;
  writePointer?: (file: string, bytes: string) => Promise<void>;
}): Promise<PublishCurrentStoryResult> {
  const reviewDir = reviewEntryPath(
    input.containmentRoot,
    input.reviewDir,
    'current Story review directory'
  );
  const twolaneDir = path.join(reviewDir, 'twolane');
  const pointerFile = reviewEntryPath(
    input.containmentRoot,
    path.join(twolaneDir, CURRENT_STORY_POINTER_FILE),
    'current Story pointer'
  );
  const writePointer =
    input.writePointer ??
    ((file: string, bytes: string) => atomicWriteFile(file, bytes, input.containmentRoot));
  const lock = reviewLock(input.containmentRoot, input.locksDir);
  return lock.withLock(reviewStateLockKey(slugifyBranch(input.branch)), async (lease) => {
    const candidate = await pointerForTerminalRun({
      twolaneDir,
      branch: input.branch,
      runId: input.runId,
    });
    let existing: CurrentStoryPointer | null = null;
    // Distinguish repairable pointer damage from a pointed run whose
    // files fail their contract: only the former may be silently
    // unseated, or a strict-parse failure on the NEWER run would let an
    // older re-publish roll the branch's current Story back.
    let pointerBytes: string | null = null;
    try {
      pointerBytes = await readFile(pointerFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let parsedPointer: CurrentStoryPointer | null = null;
    if (pointerBytes !== null) {
      let decoded: unknown = null;
      try {
        decoded = JSON.parse(pointerBytes);
      } catch {
        // A garbled pointer file is repaired below.
      }
      // Version probe BEFORE the shape parse: a pointer written by a
      // different contract version must refuse, not be repaired over —
      // an older binary silently overwriting a newer pointer is the
      // exact rollback this block exists to prevent.
      const pointerVersion = (decoded as { schema_version?: unknown } | null)?.schema_version;
      if (
        typeof pointerVersion === 'number' &&
        pointerVersion !== CURRENT_STORY_POINTER_SCHEMA_VERSION
      ) {
        throw new Error(
          `current Story pointer schema ${String(pointerVersion)} is unsupported by current ` +
            `schema ${CURRENT_STORY_POINTER_SCHEMA_VERSION} — refusing to repair over it`
        );
      }
      try {
        parsedPointer = currentStoryPointerSchema.parse(decoded);
      } catch {
        // A garbled or shape-invalid same-version pointer is repaired below.
      }
    }
    if (parsedPointer !== null && pointerBytes !== null) {
      // Monotonicity is only at stake when the pointer is at-or-newer
      // than the candidate: a damaged OLDER pointed run must not block a
      // valid newer Story — installing the newer one is a repair.
      const pointerWins = tupleCompare(parsedPointer, candidate) >= 0;
      try {
        await validatePointedRun({ twolaneDir, pointer: parsedPointer, pointerBytes });
        existing = parsedPointer;
      } catch (error) {
        // When the pointer is at-or-newer than the candidate, EVERY
        // validation failure refuses — a missing run file (ENOENT) is
        // indistinguishable from partial deletion, and repairing over it
        // would roll the branch back. Only a strictly newer candidate
        // treats the damage as repairable.
        if (pointerWins) {
          throw new Error(
            `current Story pointer for "${input.branch}" names run ` +
              `${parsedPointer.run_id}, whose run files fail their contract: ` +
              `${error instanceof Error ? error.message : String(error)} — refusing to ` +
              `unseat it; repair or remove that run explicitly`
          );
        }
      }
    }
    if (existing !== null && tupleCompare(existing, candidate) >= 0)
      return { pointer: existing, installed: false };
    const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
    try {
      await lease.verify();
      await writePointer(
        reviewEntryPath(input.containmentRoot, pointerFile, 'current Story pointer'),
        bytes
      );
    } catch (error) {
      throw new CurrentStoryInstallError(
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? { cause: error } : undefined
      );
    }
    return { pointer: candidate, installed: true };
  });
}
