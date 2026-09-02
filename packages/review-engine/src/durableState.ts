import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CommentEvent,
  commentEventSchema,
  FLOOR_SCHEMA_VERSION,
  type JournalEvent,
  journalEventSchema,
  slugifyBranch,
} from '@orcaops/review-core';

import {
  CURRENT_STORY_POINTER_FILE,
  CURRENT_STORY_POINTER_SCHEMA_VERSION,
  resolveCurrentStory,
} from './currentStory.js';
import { type FloorBundleInspection, inspectFloorBundle } from './floorSource.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath } from './reviewPaths.js';
import {
  inspectReviewStateVersion,
  resetReviewState,
  REVIEW_STATE_VERSION,
  reviewStateLockKey,
  type ReviewStateVersionHealth,
} from './reviewState.js';
import type { ReviewArgs } from './run.js';

export type DurableStateKind = 'REVIEW_STATE' | 'FLOOR' | 'STORY' | 'COMMENTS' | 'JOURNAL';
export type DurableStateStatus = 'ABSENT' | 'HEALTHY' | 'STALE' | 'UNSUPPORTED_SCHEMA' | 'CORRUPT';

export interface DurableStateHealth {
  kind: DurableStateKind;
  status: DurableStateStatus;
  path: string;
  reason: string;
  schemaVersion: number | null;
}

export interface DurableReviewStateHealth {
  schema_version: 2;
  branch: string;
  status: 'HEALTHY' | 'BLOCKED';
  states: DurableStateHealth[];
  repair: {
    command: string;
    behavior: string;
  };
}

export class DurableStateReadError extends Error {
  constructor(readonly health: DurableStateHealth) {
    super(`${health.kind}_${health.status}: ${health.reason} (${health.path})`);
  }
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

async function readText(
  file: string
): Promise<
  { status: 'ABSENT' } | { status: 'READ'; text: string } | { status: 'ERROR'; reason: string }
> {
  try {
    return { status: 'READ', text: await readFile(file, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ABSENT' };
    return { status: 'ERROR', reason: error instanceof Error ? error.message : String(error) };
  }
}

function health(
  kind: DurableStateKind,
  status: DurableStateStatus,
  file: string,
  reason: string,
  schemaVersion: number | null = null
): DurableStateHealth {
  return { kind, status, path: file, reason, schemaVersion };
}

async function readNdjson<T>(input: {
  kind: 'COMMENTS' | 'JOURNAL';
  file: string;
  schema: {
    safeParse(
      value: unknown
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  };
  validateSequence?: (events: readonly T[]) => string | null;
}): Promise<{ health: DurableStateHealth; events: T[] }> {
  const read = await readText(input.file);
  if (read.status === 'ABSENT') {
    return {
      health: health(
        input.kind,
        'ABSENT',
        input.file,
        'sidecar has no events',
        REVIEW_STATE_VERSION
      ),
      events: [],
    };
  }
  if (read.status === 'ERROR') {
    return {
      health: health(input.kind, 'CORRUPT', input.file, read.reason, REVIEW_STATE_VERSION),
      events: [],
    };
  }
  const events: T[] = [];
  for (const [index, line] of read.text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch (error) {
      return {
        health: health(
          input.kind,
          'CORRUPT',
          input.file,
          `line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          REVIEW_STATE_VERSION
        ),
        events: [],
      };
    }
    const parsed = input.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        health: health(
          input.kind,
          'CORRUPT',
          input.file,
          `line ${index + 1} violates the current schema: ${issues(parsed.error)}`,
          REVIEW_STATE_VERSION
        ),
        events: [],
      };
    }
    events.push(parsed.data);
  }
  const sequenceError = input.validateSequence?.(events) ?? null;
  if (sequenceError !== null) {
    return {
      health: health(input.kind, 'CORRUPT', input.file, sequenceError, REVIEW_STATE_VERSION),
      events: [],
    };
  }
  return {
    health: health(
      input.kind,
      'HEALTHY',
      input.file,
      `${events.length} current event(s)`,
      REVIEW_STATE_VERSION
    ),
    events,
  };
}

function validateCommentSequence(events: readonly CommentEvent[]): string | null {
  const known = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.type === 'add') {
      if (known.has(event.comment_id)) {
        return `line ${index + 1} duplicates comment add identity ${event.comment_id}`;
      }
      known.add(event.comment_id);
      continue;
    }
    if (!known.has(event.comment_id)) {
      return `line ${index + 1} references missing comment add identity ${event.comment_id}`;
    }
  }
  return null;
}

export async function readCommentEventsStrict(file: string): Promise<CommentEvent[]> {
  const result = await readNdjson({
    kind: 'COMMENTS',
    file,
    schema: commentEventSchema,
    validateSequence: validateCommentSequence,
  });
  if (result.health.status === 'CORRUPT' || result.health.status === 'UNSUPPORTED_SCHEMA') {
    throw new DurableStateReadError(result.health);
  }
  return result.events;
}

export async function readJournalEventsStrict(file: string): Promise<JournalEvent[]> {
  const result = await readNdjson({ kind: 'JOURNAL', file, schema: journalEventSchema });
  if (result.health.status === 'CORRUPT' || result.health.status === 'UNSUPPORTED_SCHEMA') {
    throw new DurableStateReadError(result.health);
  }
  return result.events;
}

/** Validate both append logs before archive replay promotes either one. */
export async function validateReviewLogFiles(
  journalFile: string,
  commentsFile: string
): Promise<void> {
  await readJournalEventsStrict(journalFile);
  await readCommentEventsStrict(commentsFile);
}

function directoryHealth(value: ReviewStateVersionHealth): DurableStateHealth {
  return health(
    'REVIEW_STATE',
    value.status,
    value.path,
    'reason' in value ? value.reason : `current review-state schema ${value.version}`,
    'version' in value ? value.version : null
  );
}

// The FLOOR row certifies the committed bundle — exactly what
// loadHealthyFloorSource certifies — never floor.json parseability alone: a
// parseable floor without its producer marker is the crash state the marker
// protocol exists to expose.
function floorHealth(dir: string, bundle: FloorBundleInspection): DurableStateHealth {
  if (bundle.status === 'HEALTHY') {
    return health(
      'FLOOR',
      'HEALTHY',
      dir,
      `current floor bundle ${bundle.floor.input_hash} validates`,
      FLOOR_SCHEMA_VERSION
    );
  }
  if (bundle.status === 'ABSENT') {
    return health(
      'FLOOR',
      'ABSENT',
      dir,
      'no current floor bundle is materialized',
      FLOOR_SCHEMA_VERSION
    );
  }
  return health('FLOOR', 'CORRUPT', dir, bundle.reason, FLOOR_SCHEMA_VERSION);
}

async function inspectCurrentStory(
  dir: string,
  floorInputHash: string | undefined
): Promise<DurableStateHealth> {
  const pointerFile = path.join(dir, 'twolane', CURRENT_STORY_POINTER_FILE);
  const resolved = await resolveCurrentStory({
    reviewDir: dir,
    ...(floorInputHash !== undefined ? { floorInputHash } : {}),
  });
  if (resolved.status === 'ABSENT') {
    return health(
      'STORY',
      'ABSENT',
      pointerFile,
      'no current Story is installed',
      CURRENT_STORY_POINTER_SCHEMA_VERSION
    );
  }
  if (resolved.status === 'OK') {
    return health(
      'STORY',
      'HEALTHY',
      pointerFile,
      floorInputHash === undefined
        ? `current Story run ${resolved.runId ?? '<unknown>'} validates; staleness unassessed without a readable current floor`
        : `current Story run ${resolved.runId ?? '<unknown>'} validates`,
      CURRENT_STORY_POINTER_SCHEMA_VERSION
    );
  }
  if (resolved.status === 'STALE') {
    return health(
      'STORY',
      'STALE',
      pointerFile,
      resolved.issue ?? 'current Story does not match the current floor',
      CURRENT_STORY_POINTER_SCHEMA_VERSION
    );
  }
  return health(
    'STORY',
    'CORRUPT',
    pointerFile,
    resolved.issue ?? 'current Story is invalid',
    CURRENT_STORY_POINTER_SCHEMA_VERSION
  );
}

// FLOOR and STORY are derived artifacts with their own regeneration commands.
const requiresReset = (state: DurableStateHealth): boolean =>
  state.kind !== 'STORY' &&
  state.kind !== 'FLOOR' &&
  ['CORRUPT', 'UNSUPPORTED_SCHEMA'].includes(state.status);

const storyNeedsRegeneration = (state: DurableStateHealth): boolean =>
  state.kind === 'STORY' && ['CORRUPT', 'STALE'].includes(state.status);

// An installed Story's staleness is unknowable without a readable floor, so a
// missing floor blocks only when a Story pointer exists; a corrupt floor
// blocks unconditionally through the aggregate CORRUPT rule.
const floorUnknowableForStory = (states: readonly DurableStateHealth[]): boolean =>
  states.some((state) => state.kind === 'FLOOR' && state.status === 'ABSENT') &&
  states.some((state) => state.kind === 'STORY' && state.status !== 'ABSENT');

const floorNeedsRegeneration = (states: readonly DurableStateHealth[]): boolean =>
  states.some((state) => state.kind === 'FLOOR' && state.status === 'CORRUPT') ||
  floorUnknowableForStory(states);

function repairGuidance(
  branch: string,
  states: readonly DurableStateHealth[]
): DurableReviewStateHealth['repair'] {
  if (!states.some(requiresReset)) {
    if (floorNeedsRegeneration(states)) {
      return {
        command: `review data --branch ${JSON.stringify(branch)}`,
        behavior:
          'regenerate the derived floor and diff; reviewer-owned comments and journal events remain unchanged',
      };
    }
    if (states.some(storyNeedsRegeneration)) {
      return {
        command: `review routine-start --branch ${JSON.stringify(branch)}`,
        behavior:
          'regenerate the derived current Story; reviewer-owned comments and journal events remain unchanged',
      };
    }
  }
  return {
    command: `review state repair --branch ${JSON.stringify(branch)}`,
    behavior:
      'delete the complete review directory and initialize empty current state; floor/diff, Story and anchor runs, coverage/journal, and comments are reset',
  };
}

export async function inspectDurableReviewState(
  root: string,
  branch: string
): Promise<DurableReviewStateHealth> {
  const branchSlug = slugifyBranch(branch);
  const dir = reviewDirPath(root, branchSlug);
  const version = directoryHealth(await inspectReviewStateVersion(dir));
  if (version.status === 'CORRUPT' || version.status === 'UNSUPPORTED_SCHEMA') {
    return {
      schema_version: 2,
      branch,
      status: 'BLOCKED',
      states: [version],
      repair: repairGuidance(branch, [version]),
    };
  }
  const comments = await readNdjson({
    kind: 'COMMENTS',
    file: path.join(dir, 'comments.ndjson'),
    schema: commentEventSchema,
    validateSequence: validateCommentSequence,
  });
  const journal = await readNdjson({
    kind: 'JOURNAL',
    file: path.join(dir, 'journal.ndjson'),
    schema: journalEventSchema,
  });
  const bundle = await inspectFloorBundle(root, branchSlug);
  const floor = floorHealth(dir, bundle);
  const story = await inspectCurrentStory(
    dir,
    bundle.status === 'HEALTHY' ? bundle.floor.input_hash : undefined
  );
  const states = [version, floor, story, comments.health, journal.health];
  return {
    schema_version: 2,
    branch,
    status:
      states.some(
        (state) =>
          ['CORRUPT', 'UNSUPPORTED_SCHEMA', 'STALE'].includes(state.status) ||
          (state.kind === 'REVIEW_STATE' && state.status === 'ABSENT')
      ) || floorUnknowableForStory(states)
        ? 'BLOCKED'
        : 'HEALTHY',
    states,
    repair: repairGuidance(branch, states),
  };
}

function emitState(value: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`);
}

export async function runDurableState(args: ReviewArgs, root: string): Promise<number> {
  if (!args.branch) {
    process.stderr.write('review state: --branch <branch> is required\n');
    return 2;
  }
  if (args.action !== 'health' && args.action !== 'repair') {
    process.stderr.write('usage: review state <health|repair> --branch <branch> [--json]\n');
    return 2;
  }
  const observed = await inspectDurableReviewState(root, args.branch);
  if (args.action === 'health') {
    emitState(
      observed,
      args.json,
      `review state ${observed.status.toLowerCase()}: ${observed.states.map((state) => `${state.kind}=${state.status}`).join(' · ')}`
    );
    return observed.status === 'HEALTHY' ? 0 : 1;
  }
  const repairable = observed.states.some(requiresReset);
  if (!repairable) {
    const floorBlocked = floorNeedsRegeneration(observed.states);
    const story = observed.states.find(storyNeedsRegeneration);
    emitState(
      {
        ok: false,
        code: floorBlocked
          ? 'FLOOR_REGENERATION_REQUIRED'
          : story === undefined
            ? 'REPAIR_NOT_REQUIRED'
            : 'STORY_REGENERATION_REQUIRED',
        health: observed,
      },
      args.json,
      floorBlocked
        ? 'current floor is missing or invalid; regenerate it with review data without resetting reviewer-owned comments or journal data'
        : story !== undefined
          ? `current Story is ${story.status.toLowerCase()}; regenerate it without resetting reviewer-owned comments or journal data`
          : 'review state is already healthy; no repair performed'
    );
    return observed.status === 'HEALTHY' ? 0 : 1;
  }
  const branchSlug = slugifyBranch(args.branch);
  const dir = reviewDirPath(root, branchSlug);
  const lock = reviewLock(root);
  const repaired = await lock.withLock(reviewStateLockKey(branchSlug), async (stateLease) => {
    return lock.withLock(branchSlug, async (slugLease) => {
      const current = await inspectDurableReviewState(root, args.branch!);
      if (!current.states.some(requiresReset)) {
        return { changed: false as const, current };
      }
      await stateLease.verify();
      await slugLease.verify();
      await resetReviewState(dir, root);
      return { changed: true as const, current };
    });
  });
  if (!repaired.changed) {
    emitState(
      {
        ok: repaired.current.status === 'HEALTHY',
        idempotent: true,
        health: repaired.current,
      },
      args.json,
      repaired.current.status === 'HEALTHY'
        ? 'review state became healthy before repair; no changes made'
        : repaired.current.repair.behavior
    );
    return repaired.current.status === 'HEALTHY' ? 0 : 1;
  }
  const result = {
    ok: true,
    code: 'REGENERATION_REQUIRED',
    reset: true,
    next: ['review data --branch <branch>', 'review routine-start --branch <branch>'],
  };
  emitState(
    result,
    args.json,
    'review state deleted and reset to the current schema — run review data and generate a fresh routine Story'
  );
  return 0;
}
