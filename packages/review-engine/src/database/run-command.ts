// The two-lane run lifecycle over the canonical store: mint, serve, submit,
// read and finalize, each composed from the accepted private run APIs.
//
// The run's state is retained rows and retained evidence — the run revision,
// its pinned input publication, one publication per attempt and the sealed
// terminal receipt. Nothing here writes a run file, and every write pins the
// exact revision and version it read, so a concurrent write refuses as stale
// instead of overwriting it.

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { loadReadOnlyProjectConfig } from '@orcaops/core';
import { DISCLOSURE_CODE, type ExecutableIdentity, type Floor } from '@orcaops/review-core';
import { resolveCaptureExcludes, uuidv7 } from '@orcaops/storage';
import {
  type ProjectDatabaseAuthority,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';

import {
  type AccountProjection,
  DOSSIER_BUDGET_V1,
  ExcludePolicyError,
  type ForensicInput,
  invalidStubPatterns,
  ReviewDiffTruncatedError,
  ROUTINE_BUDGET_V1,
  StubPolicyError,
} from '../dossier.js';
import {
  type DeclaredIsolation,
  TWOLANE_RUN_SCHEMA_VERSION,
  type TwolaneExecutionProfile,
  type TwolaneRunFile,
} from '../twolaneRunFile.js';
import { freshSliceRunState, type Lane } from '../twolaneSlice.js';
import { readDatabaseReviewContext, readDatabaseReviewWorkflowContext } from './read-context.js';
import { integrity, invalid, stale } from './request.js';
import { readRetainedReviewOperation, reviewOperationConflict } from './review-operation.js';
import { readDatabaseReviewAttempts } from './run-attempt-read.js';
import { prepareDatabaseReviewAttempt, publishDatabaseReviewAttempt } from './run-attempts.js';
import { readDatabaseReviewFinalization } from './run-finalization-read.js';
import { publishDatabaseReviewFinalization } from './run-finalization.js';
import {
  defaultRunInputPolicy,
  prepareDatabaseReviewRunInputs,
  type RunInputName,
} from './run-inputs.js';
import { recordDatabaseReviewInputsServed } from './run-progress.js';
import { readDatabaseReviewRun } from './run-read.js';
import { startDatabaseReviewRun } from './runs.js';
import { resolveDatabaseReviewAuthority } from './source-scope.js';
import { prepareDatabaseReviewFinalization } from './story-preparation.js';
import { type TerminalRecord } from './terminal-record.js';

export type RunProfile = 'routine' | 'full';

export interface CanonicalRunLocator {
  branch: string;
  root: string;
  projectId?: string;
  dataRoot?: string;
}

/**
 * The project authority alone. Receipt-first replay must read the receipt
 * before the review is selected or the run is read, so the authority is
 * resolved on its own rather than taken from the review context.
 */
async function runAuthority(input: CanonicalRunLocator): Promise<ProjectDatabaseAuthority> {
  return resolveDatabaseReviewAuthority({
    cwd: input.root,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
}

/** The committed receipt for this verb's original identity, or null. */
async function committedRunOperation(
  authority: ProjectDatabaseAuthority,
  operationId: string,
  kind: string
) {
  const committed = await readRetainedReviewOperation({ authority, operationId, kinds: [kind] });
  return committed.value;
}

function retainedRunTarget(target: Record<string, unknown>, runId: string | null): string {
  const reviewId = target.reviewId;
  const retainedRunId = target.runId;
  if (typeof reviewId !== 'string' || typeof retainedRunId !== 'string')
    integrity('The original run receipt lost its retained identities; preserve it for repair');
  if (runId !== null && retainedRunId !== runId) reviewOperationConflict();
  return reviewId;
}

async function retainedRun(
  authority: ProjectDatabaseAuthority,
  reviewId: string,
  runId: string,
  revisionId?: string
) {
  const read = await readDatabaseReviewRun({
    authority,
    reviewId,
    runId,
    ...(revisionId === undefined ? {} : { revisionId }),
  });
  if (!read.value)
    integrity('The original run is missing from its receipt; preserve history for explicit repair');
  return read.value;
}

async function reviewContext(input: CanonicalRunLocator) {
  const context = await readDatabaseReviewContext({
    branch: input.branch,
    cwd: input.root,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  if (context.floor === null)
    invalid(`no selected floor for '${input.branch}'; run review data first`);
  return context;
}

type ReviewContext = Awaited<ReturnType<typeof reviewContext>>;

function floorSelection(context: ReviewContext) {
  const current = context.selection;
  return {
    membershipRevisionId: current.membership_revision_id,
    membershipVersion: current.membership_version,
    baseRevisionId: current.base_revision_id,
    baseVersion: current.base_version,
    floorVersion: current.floor_version,
    floorPublicationId: context.floor!.publicationId,
  };
}

/**
 * The dossier budget and repo policy the run's pinned inputs are derived under.
 * A malformed stub or exclude pattern is a hole in a review control, so it
 * refuses here — before anything opens a writer — rather than silently
 * reviewing the path it was meant to withhold.
 */
async function runInputPolicy(root: string, profile: RunProfile) {
  const config = await loadReadOnlyProjectConfig(root);
  const stubPaths = config.review.stub_paths;
  const invalidStubs = invalidStubPatterns(stubPaths);
  if (invalidStubs.length > 0) throw new StubPolicyError(invalidStubs);
  const excludes = resolveCaptureExcludes(config.capture);
  if (excludes.invalid.length > 0) throw new ExcludePolicyError(excludes.invalid);
  return {
    ...defaultRunInputPolicy(),
    budget: { ...(profile === 'routine' ? ROUTINE_BUDGET_V1 : DOSSIER_BUDGET_V1) },
    stubPaths: [...stubPaths],
    excludePaths: [...excludes.patterns],
  };
}

/**
 * A truncated review diff is partial coverage. The floor records it as a
 * blocking disclosure and the routine surface must never mint a payload over
 * it, so the refusal happens before any input is prepared.
 */
function refuseTruncatedFloor(floor: Floor): void {
  const truncated = floor.disclosure.find(
    (entry) => entry.code === DISCLOSURE_CODE.LIVE_DIFF_TRUNCATED
  );
  if (truncated === undefined) return;
  const cap = /review\.max_diff_bytes \((\d+)\)/.exec(truncated.message);
  throw new ReviewDiffTruncatedError(
    truncated.message,
    cap !== null ? Number.parseInt(cap[1]!, 10) : null
  );
}

export interface StartCanonicalRun extends CanonicalRunLocator {
  profile: RunProfile;
  createdAt: string;
  runtimeIdentity: ExecutableIdentity | null;
  executionProfile: TwolaneExecutionProfile;
  operationId: string;
  secretAllow: string[];
}

export interface CanonicalRunStarted {
  reviewId: string;
  runId: string;
  branch: string;
  revisionId: string;
  publicationId: string;
  inputShas: Record<string, string>;
  /** The result came from the original operation receipt rather than a new mint. */
  replayed: boolean;
  run: TwolaneRunFile;
}

/** Mint a run whose pinned inputs are derived from the selected floor. */
export async function startCanonicalRun(
  input: StartCanonicalRun,
  options: ProjectOperationOptions = {}
): Promise<CanonicalRunStarted> {
  // Receipt first: an interrupted mint retried under its original identity
  // returns the run it minted rather than minting a second one over the same
  // floor. The branch and the declared execution profile are the authored input
  // this identity carries; a different one names different work.
  const authority = await runAuthority(input);
  const committed = await committedRunOperation(authority, input.operationId, 'review.run.start');
  if (committed) {
    const reviewId = retainedRunTarget(committed.target, null);
    const runId = committed.target.runId as string;
    const retained = await retainedRun(
      authority,
      reviewId,
      runId,
      committed.result.revisionId as string
    );
    // The routine/full `profile` is not compared: it only selects the dossier
    // budget the run's inputs were derived under, and those inputs are already
    // pinned as retained evidence. A replay returns the run the receipt names,
    // so the profile a retry supplies cannot change what is replayed — the
    // pinned inputs are the authority, not the profile that produced them.
    if (
      retained.run.branch !== input.branch ||
      !isDeepStrictEqual(retained.run.execution_profile, input.executionProfile)
    )
      reviewOperationConflict();
    return {
      reviewId,
      runId,
      branch: input.branch,
      revisionId: retained.revisionId,
      publicationId: retained.inputPublicationId,
      inputShas: retained.run.input_shas,
      replayed: true,
      run: retained.run,
    };
  }
  const context = await reviewContext(input);
  refuseTruncatedFloor(context.floor!.floor as Floor);
  const policy = await runInputPolicy(input.root, input.profile);
  const selected = floorSelection(context);
  const expected = {
    ...selected,
    currentRunId: context.selection.current_run_id,
    runSelectionVersion: context.selection.run_selection_version,
  };
  const prepared = await prepareDatabaseReviewRunInputs(
    {
      authority: context.authority,
      reviewId: context.reviewId,
      expected: selected,
      policy,
      generatedAt: input.createdAt,
      secretAllow: input.secretAllow,
    },
    { signal: options.signal }
  );
  const forensic = prepared.values['forensic-input-v1.json'] as ForensicInput;
  const run: TwolaneRunFile = {
    schema_version: TWOLANE_RUN_SCHEMA_VERSION,
    run_id: randomUUID(),
    branch: input.branch,
    mode: 'routine',
    created_at: input.createdAt,
    input_shas: prepared.inputShas,
    slice_state: freshSliceRunState(),
    lane_inputs_served: {},
    attempts: [],
    account_lineage: null,
    latency_input_bytes: forensic.metrics.eligibleDiffBytes,
    runtime_identity: input.runtimeIdentity,
    execution_profile: input.executionProfile,
    finalized: null,
  };
  const revisionId = uuidv7();
  const publicationId = uuidv7();
  const started = await startDatabaseReviewRun(
    {
      authority: context.authority,
      reviewId: context.reviewId,
      operationId: input.operationId,
      revisionId,
      publicationId,
      runBytes: Buffer.from(JSON.stringify(run, null, 2) + '\n'),
      inputs: prepared.members as { name: RunInputName; bytes: Uint8Array }[],
      policy,
      expected,
      secretAllow: input.secretAllow,
    },
    options
  );
  return {
    reviewId: context.reviewId,
    runId: run.run_id,
    branch: input.branch,
    revisionId: started.value.revisionId,
    publicationId: started.value.publicationId ?? publicationId,
    inputShas: prepared.inputShas,
    replayed: started.replayed,
    run,
  };
}

export interface CanonicalRunRead {
  reviewId: string;
  runId: string;
  revisionId: string;
  version: number;
  runSelectionVersion: number;
  run: TwolaneRunFile;
  dossierInputs: {
    dossier: unknown;
    projection: AccountProjection;
    forensicInput: ForensicInput;
  };
  floorPublicationId: string;
  membershipRevisionId: string;
  storyVersion: number;
}

function canonicalRunRead(
  reviewId: string,
  retained: NonNullable<Awaited<ReturnType<typeof readDatabaseReviewRun>>['value']>
): CanonicalRunRead {
  return {
    reviewId,
    runId: retained.runId,
    revisionId: retained.revisionId,
    version: retained.version,
    runSelectionVersion: retained.selection.run_selection_version,
    run: retained.run,
    dossierInputs: {
      dossier: retained.inputValues['dossier-v1.json'],
      projection: retained.inputValues['account-projection-v1.json'] as AccountProjection,
      forensicInput: retained.inputValues['forensic-input-v1.json'] as ForensicInput,
    },
    floorPublicationId: retained.floorPublicationId,
    membershipRevisionId: retained.membershipRevisionId,
    storyVersion: retained.selection.story_version,
  };
}

/** The selected (or named) run with its pinned inputs decoded. */
export async function readCanonicalRun(
  input: CanonicalRunLocator & { runId?: string }
): Promise<CanonicalRunRead | null> {
  const context = await reviewContext(input);
  const read = await readDatabaseReviewRun({
    authority: context.authority,
    reviewId: context.reviewId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
  if (!read.value) return null;
  return canonicalRunRead(context.reviewId, read.value);
}

export async function readCanonicalRunStatus(
  input: CanonicalRunLocator & { runId: string }
): Promise<CanonicalRunRead | null> {
  const context = await readDatabaseReviewWorkflowContext({
    branch: input.branch,
    cwd: input.root,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  if (context.floor === null)
    invalid(`no selected floor for '${input.branch}'; run review data first`);
  const read = await readDatabaseReviewRun({
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
  });
  if (!read.value) return null;
  return canonicalRunRead(context.reviewId, read.value);
}

export async function readCanonicalRunFinalization(
  input: CanonicalRunLocator & {
    reviewId: string;
    runId: string;
    revisionId: string;
    version: number;
  }
) {
  const authority = await runAuthority(input);
  const finalization = await readDatabaseReviewFinalization({
    authority,
    reviewId: input.reviewId,
    runId: input.runId,
  });
  if (
    finalization.value !== null &&
    (finalization.value.reviewId !== input.reviewId ||
      finalization.value.runId !== input.runId ||
      finalization.value.revisionId !== input.revisionId ||
      finalization.value.version !== input.version)
  )
    integrity('The retained finalization belongs to a different review run revision');
  return finalization.value;
}

/** Terminal = no further forensic submission is possible for this run. */
export function forensicTerminal(run: TwolaneRunFile): boolean {
  const lane = run.slice_state.lanes.forensic;
  return lane.accepted || lane.outcome === 'TERMINAL_REJECTED';
}

export interface CanonicalLaneServed {
  run: TwolaneRunFile;
  servedAt: string;
  /** False when the retained run already carried a first-served record. */
  recorded: boolean;
}

/**
 * Record the lane's first-served timestamp. The retained receipt is the write;
 * the payload itself is derived from the run's pinned inputs by the caller, so
 * a repeat serve records nothing and returns the original timestamp.
 */
export async function recordCanonicalLaneServed(
  input: CanonicalRunLocator & {
    runId: string;
    lane: Lane;
    servedAt: string;
    operationId: string;
    secretAllow: string[];
  },
  options: ProjectOperationOptions = {}
): Promise<CanonicalLaneServed> {
  const authority = await runAuthority(input);
  const committed = await committedRunOperation(
    authority,
    input.operationId,
    'review.run.inputs-served'
  );
  if (committed) {
    const reviewId = retainedRunTarget(committed.target, input.runId);
    if (committed.payload.lane !== input.lane) reviewOperationConflict();
    const retained = await retainedRun(
      authority,
      reviewId,
      input.runId,
      committed.payload.revisionId as string
    );
    const servedAt = retained.run.lane_inputs_served[input.lane];
    if (servedAt === undefined)
      integrity('The original first-served record is missing; preserve history for repair');
    return { run: retained.run, servedAt, recorded: false };
  }
  const context = await reviewContext(input);
  const read = await readDatabaseReviewRun({
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
  });
  if (!read.value) stale('The intended run is missing; preserve its original identity');
  const retained = read.value;
  const existing = retained.run.lane_inputs_served[input.lane];
  if (existing !== undefined) return { run: retained.run, servedAt: existing, recorded: false };
  const next: TwolaneRunFile = {
    ...retained.run,
    lane_inputs_served: { ...retained.run.lane_inputs_served, [input.lane]: input.servedAt },
  };
  await recordDatabaseReviewInputsServed(
    {
      authority: context.authority,
      reviewId: context.reviewId,
      runId: input.runId,
      operationId: input.operationId,
      revisionId: uuidv7(),
      expected: {
        revisionId: retained.revisionId,
        version: retained.version,
        runSelectionVersion: retained.selection.run_selection_version,
      },
      lane: input.lane,
      runBytes: Buffer.from(JSON.stringify(next, null, 2) + '\n'),
      secretAllow: input.secretAllow,
    },
    options
  );
  return { run: next, servedAt: input.servedAt, recorded: true };
}

export interface SubmitCanonicalLane extends CanonicalRunLocator {
  runId: string;
  lane: Lane;
  at: string;
  isolation: DeclaredIsolation;
  usageTokens: number | null;
  usageSource: string | null;
  runtimeIdentity: ExecutableIdentity | null;
  rawSubmission: string;
  operationId: string;
  secretAllow: string[];
}

export interface CanonicalLaneSubmitted {
  reviewId: string;
  runId: string;
  accepted: boolean;
  diagnostics: { code: string; message: string }[];
  /** The result came from the original operation receipt rather than a new attempt. */
  replayed: boolean;
  run: TwolaneRunFile;
}

/** Validate one lane submission and publish the attempt as retained evidence. */
export async function submitCanonicalLane(
  input: SubmitCanonicalLane,
  options: ProjectOperationOptions = {}
): Promise<CanonicalLaneSubmitted> {
  // Receipt first: a submission whose response was lost is retried under its
  // original identity and replays the attempt it settled. The lane, the declared
  // isolation and the submission bytes are the authored input; a different
  // payload under this identity would be a second attempt wearing the first
  // one's identity, which would consume a repair the reviewer never spent.
  const authority = await runAuthority(input);
  const committed = await committedRunOperation(authority, input.operationId, 'review.run.attempt');
  if (committed) {
    const reviewId = retainedRunTarget(committed.target, input.runId);
    const authored = committed.payload.authored as { lane?: unknown; isolation?: unknown };
    if (
      authored.lane !== input.lane ||
      authored.isolation !== input.isolation ||
      committed.payload.rawSubmissionBytes !==
        Buffer.from(input.rawSubmission, 'utf8').toString('base64')
    )
      reviewOperationConflict();
    const retained = await retainedRun(
      authority,
      reviewId,
      input.runId,
      committed.result.revisionId as string
    );
    return {
      reviewId,
      runId: input.runId,
      accepted: committed.result.accepted === true,
      diagnostics: retained.run.slice_state.lanes[input.lane].diagnostics,
      replayed: true,
      run: retained.run,
    };
  }
  const context = await reviewContext(input);
  const read = await readDatabaseReviewRun({
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
  });
  if (!read.value) stale('The intended run is missing; preserve its original identity');
  const retained = read.value;
  const request = {
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
    expected: {
      revisionId: retained.revisionId,
      version: retained.version,
      runSelectionVersion: retained.selection.run_selection_version,
    },
    authored: {
      lane: input.lane,
      at: input.at,
      isolation: input.isolation,
      usageTokens: input.usageTokens,
      usageSource: input.usageSource,
      runtimeIdentity: input.runtimeIdentity,
    },
    rawSubmissionBytes: Buffer.from(input.rawSubmission, 'utf8'),
    secretAllow: input.secretAllow,
  };
  const prepared = await prepareDatabaseReviewAttempt(request, { signal: options.signal });
  const published = await publishDatabaseReviewAttempt(
    {
      ...request,
      operationId: input.operationId,
      revisionId: uuidv7(),
      publicationId: uuidv7(),
      runBytes: prepared.runBytes,
    },
    options
  );
  return {
    reviewId: context.reviewId,
    runId: input.runId,
    accepted: prepared.accepted,
    diagnostics: prepared.diagnostics,
    replayed: published.replayed,
    run: prepared.run,
  };
}

export interface CanonicalRunFinalized {
  status: 'sealed' | 'already-sealed';
  reviewId: string;
  runId: string;
  outcome: TerminalRecord['outcome'];
  terminal: TerminalRecord;
  storyPublicationId: string | null;
  semanticPublicationId: string | null;
  storyGeneration: string | null;
  /** The result came from the original operation receipt rather than a new seal. */
  replayed: boolean;
}

/**
 * Seal the run: compose the accepted lanes, retain the Story bundle and the
 * terminal receipt, and advance the review's selected Story.
 *
 * A run that is already sealed returns its retained terminal receipt rather
 * than composing a second one — finalize stays replayable without minting a
 * new Story over the same run.
 */
export async function finalizeCanonicalRun(
  input: CanonicalRunLocator & {
    runId: string;
    finalizedAt: string;
    runtimeIdentity: ExecutableIdentity | null;
    operationId: string;
    secretAllow: string[];
  },
  options: ProjectOperationOptions = {}
): Promise<CanonicalRunFinalized> {
  // Receipt first: a seal whose response was lost replays its own terminal
  // receipt under the original identity, so the caller sees the outcome it
  // settled rather than the weaker `already-sealed` a second reader would get.
  const authority = await runAuthority(input);
  const committed = await committedRunOperation(
    authority,
    input.operationId,
    'review.run.finalize'
  );
  if (committed) {
    const reviewId = retainedRunTarget(committed.target, input.runId);
    const sealed = await readDatabaseReviewFinalization({
      authority,
      reviewId,
      runId: input.runId,
    });
    if (!sealed.value)
      integrity('The original terminal receipt is missing; preserve history for explicit repair');
    const story = sealed.value.publications.find((entry) => entry.kind === 'story');
    const semantic = sealed.value.publications.find((entry) => entry.kind === 'semantic');
    return {
      status: 'sealed',
      reviewId,
      runId: input.runId,
      outcome: sealed.value.terminal.outcome,
      terminal: sealed.value.terminal,
      storyPublicationId: story?.publicationId ?? null,
      semanticPublicationId: semantic?.publicationId ?? null,
      storyGeneration: story?.generation ?? null,
      replayed: true,
    };
  }
  const context = await reviewContext(input);
  const present = await readDatabaseReviewRun({
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
  });
  if (!present.value) stale('The intended run is missing; preserve its original identity');
  const sealed = await readDatabaseReviewFinalization({
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
  });
  if (sealed.value) {
    const story = sealed.value.publications.find((entry) => entry.kind === 'story');
    const semantic = sealed.value.publications.find((entry) => entry.kind === 'semantic');
    return {
      status: 'already-sealed',
      reviewId: context.reviewId,
      runId: input.runId,
      outcome: sealed.value.terminal.outcome,
      terminal: sealed.value.terminal,
      storyPublicationId: story?.publicationId ?? null,
      semanticPublicationId: semantic?.publicationId ?? null,
      storyGeneration: story?.generation ?? null,
      replayed: false,
    };
  }
  const read = await readDatabaseReviewAttempts({
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
  });
  if (!read.value) stale('The intended run is missing; preserve its original identity');
  const retained = read.value;
  const expected = {
    revisionId: retained.revisionId,
    version: retained.version,
    runSelectionVersion: retained.selection.run_selection_version,
    floorPublicationId: retained.floorPublicationId,
    membershipRevisionId: retained.membershipRevisionId,
    storyVersion: retained.selection.story_version,
  };
  const request = {
    authority: context.authority,
    reviewId: context.reviewId,
    runId: input.runId,
    expected,
    finalizedAt: input.finalizedAt,
    runtimeIdentity: input.runtimeIdentity,
    secretAllow: input.secretAllow,
  };
  const prepared = await prepareDatabaseReviewFinalization(request, { signal: options.signal });
  const published = await publishDatabaseReviewFinalization(
    {
      ...request,
      operationId: input.operationId,
      revisionId: uuidv7(),
      publicationId: prepared.outcome === 'FAILED' ? null : uuidv7(),
      runBytes: prepared.runBytes,
      members: prepared.requiredMembers.map((member) => ({
        name: member.name,
        bytes: member.bytes,
      })),
    },
    options
  );
  const terminal = published.value.terminal as TerminalRecord;
  return {
    status: 'sealed',
    reviewId: context.reviewId,
    runId: input.runId,
    outcome: terminal.outcome,
    terminal,
    storyPublicationId: published.value.publicationId,
    semanticPublicationId: published.value.semanticPublicationId,
    storyGeneration: published.value.generation,
    replayed: published.replayed,
  };
}
