// `review start|lane-input|lane-submit|run-show|finalize` — the public
// two-lane run lifecycle. Deterministic
// infrastructure ONLY: these verbs mint runs, serve immutable lane inputs,
// validate submissions through the slice state machine, and render the
// merged output. Their outputs are bounded to data, schema/contract
// declarations, identifiers, and validation diagnostics — never review
// prompts or behavioral instructions. The canonical task-review skill is
// the program that drives them; every model-facing instruction lives
// there, and nothing here ever invokes a model directly or by proxy.
//
// ROUTINE mode (the only built mode): a forensic-first two-lens review by
// one fresh reviewer. The engine enforces the order — account context is
// refused until the forensic lane is terminal — so capture blindness is a
// deterministic guarantee, not an instruction.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError } from 'zod';

import { type ExecutableIdentity, parseCitationId, slugifyBranch } from '@orcaops/review-core';
import { ArtifactLock, ArtifactLockLeaseLostError, atomicWriteFile } from '@orcaops/storage';

import { CLAIM_LEDGER_SHARED_EXPLANATIONS } from './claimLedger.js';
import {
  CURRENT_STORY_INSTALL_FAILED,
  publishCurrentStoryForRun,
  type PublishCurrentStoryResult,
} from './currentStory.js';
import {
  type AccountProjection,
  type DossierV1,
  type ForensicInput,
  parseAccountProjectionJson,
  parseDossierV1Json,
  parseForensicInputJson,
} from './dossier.js';
import { reviewLock } from './reviewLock.js';
import { reviewDirPath, reviewEntryPath } from './reviewPaths.js';
import { requireReviewStateVersion, reviewStateLockKey } from './reviewState.js';
import type { ReviewArgs } from './run.js';
import {
  prepareSemanticAnchorInput,
  SEMANTIC_ANCHOR_INPUT_FILE,
  SEMANTIC_ANCHOR_RECEIPT_FILE,
  type SemanticAnchorPreparation,
  unavailableSemanticAnchorPreparation,
} from './semanticAnchors.js';
import { type CoverageInput, PartOwnershipInvariantError } from './storyOwnership.js';
import {
  projectStoryReviewModel,
  serializeStoryReviewModelForInstall,
  STORY_REVIEW_MODEL_FILE,
  StoryReviewModelCatalogError,
  StoryReviewModelInvariantError,
  StoryReviewModelProjectionError,
  StoryReviewModelRangeError,
} from './storyReviewModel.js';
import {
  canonicalJsonSha256,
  normalizeSubmission,
  type SubmissionNormalizationCode,
} from './submissionNormalization.js';
import {
  type DeclaredIsolation,
  executionProfileFieldSchema,
  ISOLATION_VALUES,
  readTwolaneRunFile,
  type RoutineNormalizationCode,
  type RoutineNormalizationSummaryCode,
  TWOLANE_RUN_FILE,
  TWOLANE_RUN_RECORD_SCHEMA_VERSION,
  TWOLANE_RUN_SCHEMA_VERSION,
  type TwolaneAttemptRecord,
  type TwolaneExecutionProfile,
  type TwolaneRunFile,
} from './twolaneRunFile.js';
import {
  type AccountPayload,
  type AuthoredAccountPayload,
  buildAccountPromptAliases,
  type ComposedStory,
  composeStory,
  type ForensicPayload,
  freshSliceRunState,
  type Lane,
  partitionAccountEvaluatorRuns,
  renderSlice,
  ROUTINE_STORY_AUTHORING_SCHEMA_VERSION,
  SLICE_SCHEMA_VERSION,
  sliceContext,
  type SliceRunState,
  submitLane,
} from './twolaneSlice.js';

// Run-file contract re-exports: the schema and reader live in the
// dependency-neutral twolaneRunFile.ts; existing importers keep this path.
export {
  type AccountSubmissionLineage,
  type DeclaredIsolation,
  type ExecutionProfileField,
  readTwolaneRunFile,
  type RoutineNormalizationCode,
  type RoutineNormalizationSummaryCode,
  TWOLANE_RUN_SCHEMA_VERSION,
  type TwolaneAttemptRecord,
  type TwolaneExecutionProfile,
  type TwolaneRunFile,
  TwolaneRunFileError,
} from './twolaneRunFile.js';

export const ROUTINE_ORDER_MESSAGE =
  'account context is served only after the forensic lane is terminal (accepted, or its submission attempts can no longer be repaired)';

const RUN_RECORD_FILE = 'run-record-v1.json';
const COMPOSED_STORY_FILE = 'composed-story-v2.json';
const INPUT_FILES = {
  dossier: 'dossier-v1.json',
  projection: 'account-projection-v1.json',
  forensic_input: 'forensic-input-v1.json',
} as const;
/**
 * Optional snapshot pinned alongside the required INPUT_FILES: the floor's
 * persisted attribution coverage. Absent when the dossier predates the
 * coverage snapshot — the composition then finalizes as a labeled degraded
 * ownership state rather than fabricating a topology.
 */
const COVERAGE_FILE = 'coverage-v1.json';
/**
 * The unified diff the floor was derived from, pinned alongside coverage so the
 * run is self-contained: the Story review model's Part ranges round-trip against
 * THIS file at install, and the TUI renders the per-Part diff from it.
 */
const DIFF_FILE = 'diff.patch';
const LANE_MD_FILE: Record<Lane, string> = {
  account: 'lane-account.md',
  forensic: 'lane-forensic.md',
};

type IsolationStatus = 'SUBAGENT_FRESH' | 'SEQUENTIAL' | 'UNKNOWN';

const executionProfileSchema = z
  .object({
    host: executionProfileFieldSchema.nullish(),
    host_version: executionProfileFieldSchema.nullish(),
    model: executionProfileFieldSchema.nullish(),
    effort: executionProfileFieldSchema.nullish(),
    launcher_mode: executionProfileFieldSchema.nullish(),
    instruction_hash: executionProfileFieldSchema.nullish(),
  })
  .strict();

const unknownExecutionProfile = (): TwolaneExecutionProfile => ({
  host: null,
  host_version: null,
  model: null,
  effort: null,
  launcher_mode: null,
  instruction_hash: null,
});

const parseExecutionProfile = (
  raw: string | undefined
): { ok: true; profile: TwolaneExecutionProfile } | { ok: false; message: string } => {
  if (raw === undefined) return { ok: true, profile: unknownExecutionProfile() };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `--execution-profile-json is not valid JSON: ${String(error)}` };
  }
  const parsed = executionProfileSchema.safeParse(decoded);
  if (!parsed.success)
    return {
      ok: false,
      message: `--execution-profile-json is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
    };
  return {
    ok: true,
    profile: {
      host: parsed.data.host ?? null,
      host_version: parsed.data.host_version ?? null,
      model: parsed.data.model ?? null,
      effort: parsed.data.effort ?? null,
      launcher_mode: parsed.data.launcher_mode ?? null,
      instruction_hash: parsed.data.instruction_hash ?? null,
    },
  };
};

/**
 * Payload contracts served by `lane-input`: declarative statements of what a
 * VALID submission IS (shape, enums, membership rules, routine caps).
 * Contract text is fixture-pinned (twolane-cli-constants fixture) so any
 * drift toward instruction text surfaces as a test diff.
 */
export const LANE_CONTRACTS: Record<Lane, Record<string, unknown>> = {
  account: {
    schema_version: SLICE_SCHEMA_VERSION,
    lane: 'account',
    payload_format:
      'the served input is line-oriented markdown with engine-issued global aliases: k# maps to one canonical checkpoint and c# maps to one canonical citation',
    payload_shape:
      '{"schema_version": 1, "overview": {"text", "citations": ["c#", ...]}, "acts": [{"title", "interpretation"?, "parts": [...]}], "questions": [...]} — strict; unknown keys are rejected; the engine assigns A1/P1 ids and derives membership from nesting',
    authoring_schema_version: ROUTINE_STORY_AUTHORING_SCHEMA_VERSION,
    overview_shape:
      '{"text", "citations": ["c#", ...]} — required; text is non-empty, at most 150 words, and contains no bracketed known prompt-local aliases such as [c3]; citations contain at least one unique engine-issued c# alias',
    part_shape:
      '{"title", "checkpoints": ["k#", ...], "interpretation", "citations": ["c#", ...]} — strict; the model authors causal grouping and meaning only, never ids, cross-references, or code ownership',
    act_shape: '{"title", "interpretation"?, "parts": [...]} — strict',
    checkpoint_ref_rule:
      'use only engine-issued k# aliases; every served completed checkpoint must appear in exactly one nested Part',
    citations_rule: 'each Part carries at least one engine-issued c# alias from the prompt mapping',
    question_shape: 'string, or {"text", "citations"?} — strict',
    routine_caps:
      'overview text is at most 150 words; each Act/Part title is at most 8 words and 120 Unicode code points; each interpretation is at most 80 words; at most 3 judgment questions, each at most 60 words; all limits are hard ceilings, never targets',
  },
  forensic: {
    schema_version: SLICE_SCHEMA_VERSION,
    lane: 'forensic',
    payload_format:
      'the served input is line-oriented text: a header, the coverage inventory, then the literal unified diff',
    payload_shape: '{"findings": [...], "questions": [...]} — strict; unknown keys are rejected',
    finding_shape:
      '{"claim", "file", "related_files", "severity", "confidence"} — strict; related_files permits at most 4 unique paths distinct from file, and slot/citations fields are not part of this lane',
    // INFO is NOT listed: validation rejects it (ROUTINE_LIMITS_V1.bannedSeverity),
    // and the next line says so. Offering a value the same object forbids cost an
    // agent its only repair.
    severity_values: ['CRITICAL', 'CAUTION', 'REVIEW'],
    confidence_values: ['HIGH', 'MEDIUM', 'LOW'],
    file_rule:
      'file and every related_files entry must be an exact changed non-capture path present in the served payload',
    question_shape: 'string, or {"text", "file"?} — strict',
    routine_caps:
      'at most 3 findings (each claim at most 60 words) and at most 1 question; severity INFO is not accepted',
  },
};

// ---------------------------------------------------------------------------
// Run state on disk: .orcaops/reviews/<slug>/twolane/<run-id>/
// ---------------------------------------------------------------------------

export interface AcceptedAccountEnvelope {
  schema_version: 1;
  normalization_code: RoutineNormalizationSummaryCode;
  normalization_codes: RoutineNormalizationCode[];
  normalized_authored: AuthoredAccountPayload;
  compiled_payload: AccountPayload;
  inner: {
    raw_submission_sha256: string;
    normalized_authored_sha256: string;
    compiled_payload_sha256: string;
    diagnostic_codes: string[];
  };
}

const sha16 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

const reviewDirFor = (root: string, branch: string): string =>
  reviewDirPath(root, slugifyBranch(branch));

const runDirFor = (root: string, branch: string, runId: string): string =>
  reviewEntryPath(
    root,
    path.join(reviewDirFor(root, branch), 'twolane', runId),
    'routine review run directory'
  );

const lockFor = (root: string): ArtifactLock => reviewLock(root);

type VerifyReviewLease = () => Promise<void>;

const withReviewStateLock = <T>(
  root: string,
  branch: string,
  fn: (verifyLease: VerifyReviewLease) => Promise<T>
): Promise<T> =>
  lockFor(root).withLock(reviewStateLockKey(slugifyBranch(branch)), (lease) =>
    fn(() => lease.verify())
  );

const withTwolaneRunLock = <T>(
  root: string,
  branch: string,
  runId: string,
  fn: (verifyLeases: VerifyReviewLease) => Promise<T>
): Promise<T> => {
  const lock = lockFor(root);
  return lock.withLock(reviewStateLockKey(slugifyBranch(branch)), (stateLease) =>
    lock.withLock(`twolane-${runId}`, (runLease) =>
      fn(async () => {
        await stateLease.verify();
        await runLease.verify();
      })
    )
  );
};

const writeRunFile = (root: string, runDir: string, run: TwolaneRunFile): Promise<void> =>
  atomicWriteFile(path.join(runDir, TWOLANE_RUN_FILE), `${JSON.stringify(run, null, 2)}\n`, root);

const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

/**
 * Single failure funnel for the two-lane verbs (and the routine-start
 * dispatcher in run.ts). Under --json the failure is a parseable envelope on
 * stdout — an automated caller must never have to scrape stderr — with the
 * exit code preserved; without --json the human stderr line is unchanged.
 */
export const reviewVerbFailure = (
  args: Pick<ReviewArgs, 'json'>,
  verb: string,
  message: string,
  code: number
): number => {
  if (args.json === true) emit({ ok: false, error: { verb: `review ${verb}`, message } });
  else process.stderr.write(`review ${verb}: ${message}\n`);
  return code;
};

const fail = reviewVerbFailure;

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Terminal = no further forensic submission is possible for this run. */
const forensicTerminal = (state: SliceRunState): boolean =>
  state.lanes.forensic.accepted || state.lanes.forensic.outcome === 'TERMINAL_REJECTED';

const stateEnvelope = (state: SliceRunState) => ({
  lanes: state.lanes,
  repair_credit: {
    account: state.lanes.account.repairCredit,
    forensic: state.lanes.forensic.repairCredit,
  },
});

// ---------------------------------------------------------------------------
// Readable lane payloads: line-oriented text derived from the
// immutable snapshots — data and identifiers only, ids verbatim.
// ---------------------------------------------------------------------------

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const isReferenceContinuation = (text: string, index: number, direction: -1 | 1): boolean => {
  const char = text[index];
  if (char === undefined) return false;
  if (/[A-Za-z0-9_/:-]/.test(char)) return true;
  // A sentence-final period is a delimiter; a period followed/preceded by a
  // path character continues a filename (`a.tsx` and `a.ts.test` stay distinct
  // from `a.ts`). Ambiguous punctuation is kept rather than elided.
  if (char !== '.') return false;
  const neighbour = text[index + direction];
  return neighbour !== undefined && /[A-Za-z0-9_/:-]/.test(neighbour);
};

/** Match a complete checkpoint/file reference, never a resembling prefix. */
const hasExactReference = (text: string, reference: string): boolean => {
  if (reference.length === 0) return false;
  let offset = 0;
  while (offset <= text.length - reference.length) {
    const index = text.indexOf(reference, offset);
    if (index < 0) return false;
    const afterIndex = index + reference.length;
    if (
      !isReferenceContinuation(text, index - 1, -1) &&
      !isReferenceContinuation(text, afterIndex, 1)
    )
      return true;
    offset = index + 1;
  }
  return false;
};

const replaceExactReference = (text: string, reference: string, replacement: string): string => {
  if (reference.length === 0 || reference === replacement) return text;
  const parts: string[] = [];
  let cursor = 0;
  while (cursor <= text.length - reference.length) {
    const index = text.indexOf(reference, cursor);
    if (index < 0) break;
    const afterIndex = index + reference.length;
    if (
      isReferenceContinuation(text, index - 1, -1) ||
      isReferenceContinuation(text, afterIndex, 1)
    ) {
      parts.push(text.slice(cursor, index + 1));
      cursor = index + 1;
      continue;
    }
    parts.push(text.slice(cursor, index), replacement);
    cursor = afterIndex;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
};

export function renderForensicRoutineMd(input: ForensicInput): string {
  const m = input.metrics;
  // Defensive against payloads pinned before review.stub_paths landed: an older
  // forensic-input-v1.json carries no policy-stub fields.
  const policyStubs = input.policyStubs ?? [];
  const policyStubFiles = m.policyStubFiles ?? policyStubs.length;
  const policyStubRows = m.policyStubRows ?? policyStubs.reduce((n, s) => n + s.adds + s.dels, 0);
  const policyStubBytes = m.policyStubBytes ?? policyStubs.reduce((n, s) => n + s.bytes, 0);
  const lines: string[] = [];
  lines.push('# Forensic lane input');
  lines.push('');
  lines.push(`base: ${input.baseSha ?? 'UNKNOWN'}`);
  // Row accounting: the complete eligible diff is below, verbatim. Rows held out
  // of it are capture internals (excluded), true binaries (unreviewable), and
  // explicit policy stubs (review.stub_paths) — all enumerated so nothing is
  // silently dropped.
  lines.push(
    `coverage: ${m.eligibleFiles} eligible file(s) rendered verbatim (${m.eligibleDiffBytes} bytes) · ${m.excludedFiles} capture-internal excluded · ${m.unreviewableFiles} binary unreviewable · ${policyStubFiles} policy-stubbed`
  );
  if (input.excludedPaths.length > 0)
    lines.push(`capture-internal (excluded): ${input.excludedPaths.join(', ')}`);
  if (input.unreviewablePaths.length > 0)
    lines.push(`binary (unreviewable, not in diff): ${input.unreviewablePaths.join(', ')}`);
  // Loud stub lines: each policy-stubbed file, its row/byte counts, and the
  // reason — held out of the diff below, NOT counted against the transport
  // ceiling (review.stub_paths). Nothing is silently dropped.
  if (policyStubs.length > 0) {
    lines.push(
      `policy-stubbed (review.stub_paths, NOT in diff, ${policyStubRows} row(s) / ${policyStubBytes} bytes held out of the transport ceiling):`
    );
    for (const s of policyStubs)
      lines.push(`  stub ${s.path} — +${s.adds}/-${s.dels} rows, ${s.bytes} bytes [${s.reason}]`);
  }
  lines.push('');
  lines.push('## Diff');
  lines.push('');
  lines.push(input.diff);
  return `${lines.join('\n')}\n`;
}

/**
 * Facts about THE RUN THAT IS EXECUTING NOW, served to the account lane.
 *
 * The account lane reads captured history and nothing else, so it had no way to
 * tell a historical claim from a current one: it could ask whether a
 * Story-quality rerun should happen WHILE authoring one, or call the 1–2 MB
 * latency tier unexercised WHILE exercising it. Prose alone cannot fix that,
 * because the model had no structural access to the present. This block gives
 * it one.
 *
 * The payload's own byte size is deliberately absent: it is self-referential
 * (writing it changes it) and a serve-time concept. The forensic header
 * sidesteps the same way, by printing eligible-diff bytes instead.
 */
export interface AccountRunFacts {
  runId: string;
  baseSha: string | null;
  floorInputHash: string;
  eligibleFiles: number;
  eligibleDiffBytes: number;
  excludedFiles: number;
  unreviewableFiles: number;
  policyStubFiles: number;
  policyStubRows: number;
  latencyTier: string;
}

export type RoutineLatencyTier = 'LT_250KB' | 'FROM_250KB_TO_LT_1MB' | 'FROM_1MB_TO_2MB';
export interface RoutineLatencyProfile {
  latency_input_bytes: number;
  latency_tier: RoutineLatencyTier;
  latency_budget_ms: number;
}

/** Decimal-byte tiers over the exact policy-eligible forensic diff. */
export function latencyProfileFor(eligibleDiffBytes: number): RoutineLatencyProfile {
  if (!Number.isInteger(eligibleDiffBytes) || eligibleDiffBytes < 0)
    throw new Error(`latency input bytes must be a non-negative integer, got ${eligibleDiffBytes}`);
  if (eligibleDiffBytes < 250_000)
    return {
      latency_input_bytes: eligibleDiffBytes,
      latency_tier: 'LT_250KB',
      latency_budget_ms: 180_000,
    };
  if (eligibleDiffBytes < 1_000_000)
    return {
      latency_input_bytes: eligibleDiffBytes,
      latency_tier: 'FROM_250KB_TO_LT_1MB',
      latency_budget_ms: 300_000,
    };
  if (eligibleDiffBytes <= 2_000_000)
    return {
      latency_input_bytes: eligibleDiffBytes,
      latency_tier: 'FROM_1MB_TO_2MB',
      latency_budget_ms: 480_000,
    };
  throw new Error(
    `latency input ${eligibleDiffBytes} exceeds the 2,000,000-byte forensic transport ceiling`
  );
}

/** Frozen latency tiers. Bounds wall-clock against work served. */
export function latencyTierFor(eligibleDiffBytes: number): string {
  const profile = latencyProfileFor(eligibleDiffBytes);
  if (profile.latency_tier === 'LT_250KB') return '<250KB → 180s';
  if (profile.latency_tier === 'FROM_250KB_TO_LT_1MB') return '250KB–1MB → 300s';
  return '1MB–2MB → 480s';
}

export function renderAccountRoutineMd(p: AccountProjection, facts?: AccountRunFacts): string {
  const c = p.accountCore;
  const L: string[] = [];
  const promptAliases = buildAccountPromptAliases(p);
  const checkpointAlias = new Map(
    promptAliases.checkpoints.map((entry) => [entry.canonical, entry.alias])
  );
  // Ledger prose/anchors predate projection aliasing, so they can carry either
  // the compact artifact alias or its full UUID. Resolve both through the same
  // k# coordinate without publishing another lookup table.
  const checkpointReferenceAliases = new Map(checkpointAlias);
  for (const entry of promptAliases.checkpoints) {
    const separator = entry.canonical.lastIndexOf(':cp');
    if (separator < 0) continue;
    const artifactAlias = entry.canonical.slice(0, separator);
    const fullArtifact = p.artifactAliases[artifactAlias];
    if (fullArtifact !== undefined)
      checkpointReferenceAliases.set(
        `${fullArtifact}${entry.canonical.slice(separator)}`,
        entry.alias
      );
  }
  const orderedCheckpointReferences = [...checkpointReferenceAliases.entries()].sort(
    ([a], [b]) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)
  );
  const replaceCheckpointReferences = (text: string): string =>
    orderedCheckpointReferences.reduce(
      (rendered, [reference, alias]) => replaceExactReference(rendered, reference, alias),
      text
    );
  const citationAlias = new Map(
    promptAliases.citations.map((entry) => [entry.canonical, entry.alias])
  );
  const cAlias = (canonical: string): string => citationAlias.get(canonical) ?? canonical;
  type CitedRow = { citationId: string; text: string };
  const artifactOf = (row: CitedRow): string | null =>
    parseCitationId(row.citationId)?.artifact ?? null;
  const bySourceOrder = (a: CitedRow, b: CitedRow): number => {
    const ap = parseCitationId(a.citationId);
    const bp = parseCitationId(b.citationId);
    if (ap !== null && bp !== null) {
      const artifactOrder = ap.artifact < bp.artifact ? -1 : ap.artifact > bp.artifact ? 1 : 0;
      if (artifactOrder !== 0) return artifactOrder;
      const checkpointOrder = (ap.checkpointN ?? 0) - (bp.checkpointN ?? 0);
      if (checkpointOrder !== 0) return checkpointOrder;
      if (ap.index !== bp.index) return ap.index - bp.index;
    }
    return a.citationId < b.citationId ? -1 : a.citationId > b.citationId ? 1 : 0;
  };
  const rowsForArtifact = <T extends CitedRow>(rows: readonly T[], artifact: string): T[] =>
    rows.filter((row) => artifactOf(row) === artifact).sort(bySourceOrder);
  const checkpointSuffix = (row: CitedRow): string => {
    const parsed = parseCitationId(row.citationId);
    if (parsed?.checkpointN == null) return '';
    const ref = `${parsed.artifact}:cp${parsed.checkpointN}`;
    return ` @ ${checkpointAlias.get(ref) ?? ref}`;
  };
  const evidenceBody = (text: string): string => {
    const separator = text.indexOf(' — ');
    return oneLine(separator >= 0 ? text.slice(separator + 3) : text);
  };
  type EvaluatorCount = 'PASS' | 'INFO' | 'SKIPPED' | 'VIOLATION' | 'ERROR' | 'UNCLASSIFIED';
  const evaluatorCount = (run: (typeof c.evaluatorRuns)[number]): EvaluatorCount => {
    const metadata = run.evaluator;
    if (metadata.run_status === 'error') return 'ERROR';
    if (metadata.run_status === 'skipped') return 'SKIPPED';
    if (metadata.verdict === 'pass') return 'PASS';
    if (metadata.verdict === 'info') return 'INFO';
    if (metadata.verdict === 'violation') return 'VIOLATION';
    return 'UNCLASSIFIED';
  };
  const evaluatorCounts = (runs: typeof c.evaluatorRuns): string => {
    const counts = new Map<EvaluatorCount, number>();
    for (const run of runs) {
      const label = evaluatorCount(run);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return (['PASS', 'INFO', 'SKIPPED', 'VIOLATION', 'ERROR', 'UNCLASSIFIED'] as const)
      .flatMap((label) => {
        const count = counts.get(label) ?? 0;
        return count === 0 ? [] : [`${count} ${label}`];
      })
      .join(' · ');
  };

  // Keep the engine's canonical alias maps private. The model only needs the
  // aliases where it reads the records; publishing a second c#/k# lookup table
  // made the same corpus expensive to scan twice.
  L.push('# Account lane input — the captured account');
  L.push('');
  L.push(`branch: ${p.branch}`);
  if (facts !== undefined) {
    L.push('');
    L.push('## THIS RUN (executing now — not captured history)');
    L.push('');
    L.push(
      'Everything under the headings below is the CAPTURED RECORD: statements made in the past. The facts here describe the review run you are authoring right now. Where a captured statement says something is untested, unrun, unresolved, or future work, check it against these facts before repeating it.'
    );
    L.push('');
    L.push(`run: ${facts.runId} · executing now · branch ${p.branch}`);
    L.push(`base: ${facts.baseSha ?? 'UNKNOWN'} · floor ${facts.floorInputHash}`);
    L.push(
      `diff under review: ${facts.eligibleFiles} eligible file(s), ${facts.eligibleDiffBytes} bytes · ${facts.excludedFiles} capture-internal excluded · ${facts.unreviewableFiles} binary unreviewable · ${facts.policyStubFiles} policy-stubbed (${facts.policyStubRows} row(s) held out)`
    );
    L.push(`latency tier in force for this run: ${facts.latencyTier}`);
  }
  L.push('');
  L.push('Cite captured records with their inline [c#] aliases and checkpoints with k# aliases.');

  const planDecisions = c.planDecisions;
  const criterionEvidence = c.criterionEvidence;
  const verification = c.verification;
  const evaluatorRuns = c.evaluatorRuns;
  const renderableStepIds = new Set(
    c.planSteps.filter((step) => artifactOf(step) !== null).map((step) => step.citationId)
  );
  const renderableCriterionIds = new Set(
    c.acceptanceCriteria
      .filter(
        (criterion) => artifactOf(criterion) !== null || renderableStepIds.has(criterion.parent)
      )
      .map((criterion) => criterion.citationId)
  );
  const matchedEvidenceIds = new Set(
    criterionEvidence
      .filter((e) => e.parent !== undefined && renderableCriterionIds.has(e.parent))
      .map((e) => e.citationId)
  );

  // Checkpoint order is the captured thread order. Citation-only artifacts are
  // appended deterministically so even a legacy floor with no checkpoint rows
  // still renders all protected records.
  const artifactOrder: string[] = [];
  const addArtifact = (artifact: string | null): void => {
    if (artifact !== null && !artifactOrder.includes(artifact)) artifactOrder.push(artifact);
  };
  for (const cp of c.checkpoints) addArtifact(cp.artifact);
  const artifactScopedRows: CitedRow[] = [
    ...c.planSteps,
    ...c.nonGoals,
    ...planDecisions,
    ...c.acceptanceCriteria,
    ...criterionEvidence.filter(
      (evidence) => evidence.parent === undefined || !renderableCriterionIds.has(evidence.parent)
    ),
    ...verification,
    ...evaluatorRuns,
  ];
  const remainingArtifacts = [
    ...new Set(
      artifactScopedRows.map(artifactOf).filter((artifact): artifact is string => artifact !== null)
    ),
  ]
    .filter((artifact) => !artifactOrder.includes(artifact))
    .sort();
  for (const artifact of remainingArtifacts) addArtifact(artifact);

  const renderEvidence = (evidence: (typeof criterionEvidence)[number], indent: string): void => {
    L.push(
      `${indent}- evidence [${cAlias(evidence.citationId)}]${checkpointSuffix(evidence)} ${evidenceBody(evidence.text)}`
    );
  };

  for (const artifact of artifactOrder) {
    L.push('');
    L.push(`## Artifact ${artifact}`);
    L.push('');
    L.push('### Plan');
    L.push('');

    const steps = rowsForArtifact(c.planSteps, artifact);
    const criteriaShown = new Set<string>();
    let planRows = 0;
    for (const step of steps) {
      planRows += 1;
      L.push(`- step [${cAlias(step.citationId)}] ${oneLine(step.text)}`);
      const criteria = c.acceptanceCriteria
        .filter((criterion) => criterion.parent === step.citationId)
        .sort(bySourceOrder);
      for (const criterion of criteria) {
        criteriaShown.add(criterion.citationId);
        L.push(`  - criterion [${cAlias(criterion.citationId)}] ${oneLine(criterion.text)}`);
        const evidence = criterionEvidence
          .filter((row) => row.parent === criterion.citationId)
          .sort(bySourceOrder);
        if (evidence.length === 0) L.push('    - no captured close evidence');
        for (const row of evidence) renderEvidence(row, '    ');
      }
    }

    const unassignedCriteria = rowsForArtifact(c.acceptanceCriteria, artifact).filter(
      (criterion) =>
        !criteriaShown.has(criterion.citationId) && !renderableStepIds.has(criterion.parent)
    );
    if (unassignedCriteria.length > 0) {
      L.push('- unassigned criteria (unresolved plan-step link):');
      for (const criterion of unassignedCriteria) {
        planRows += 1;
        L.push(`  - criterion [${cAlias(criterion.citationId)}] ${oneLine(criterion.text)}`);
        const evidence = criterionEvidence
          .filter((row) => row.parent === criterion.citationId)
          .sort(bySourceOrder);
        if (evidence.length === 0) L.push('    - no captured close evidence');
        for (const row of evidence) renderEvidence(row, '    ');
      }
    }

    const nonGoals = rowsForArtifact(c.nonGoals, artifact);
    if (nonGoals.length > 0) {
      planRows += nonGoals.length;
      L.push('- non-goals:');
      for (const nonGoal of nonGoals)
        L.push(`  - non-goal [${cAlias(nonGoal.citationId)}] ${oneLine(nonGoal.text)}`);
    }

    const decisions = rowsForArtifact(planDecisions, artifact);
    if (decisions.length > 0) {
      planRows += decisions.length;
      L.push('- plan decisions:');
      for (const d of decisions) {
        L.push(`  - decision [${cAlias(d.citationId)}] ${oneLine(d.text)}`);
        for (const alt of [...d.alternatives].sort(bySourceOrder))
          L.push(`    - alternative [${cAlias(alt.citationId)}] ${oneLine(alt.text)}`);
      }
    }
    if (planRows === 0) L.push('(none captured)');

    const checkpoints = c.checkpoints
      .filter((cp) => cp.artifact === artifact)
      .sort((a, b) => a.cp - b.cp);
    if (checkpoints.length > 0) {
      L.push('');
      L.push('### Checkpoints');
    }
    for (const cp of checkpoints) {
      L.push('');
      const canonicalRef = `${cp.artifact}:cp${cp.cp}`;
      L.push(
        `#### ${checkpointAlias.get(canonicalRef) ?? canonicalRef} · ${canonicalRef}${cp.label !== null ? ` — ${oneLine(cp.label)}` : ''}`
      );
      if (cp.summary !== null) L.push(oneLine(cp.summary));
      for (const d of cp.decisions) {
        L.push(`- decision [${cAlias(d.citationId)}] ${oneLine(d.text)}`);
        for (const alt of d.alternatives)
          L.push(`  - alternative [${cAlias(alt.citationId)}] ${oneLine(alt.text)}`);
      }
      for (const u of cp.uncertainty)
        L.push(`- uncertainty [${cAlias(u.citationId)}] ${oneLine(u.text)}`);
      for (const row of verification
        .filter((item) => {
          const parsed = parseCitationId(item.citationId);
          return parsed?.artifact === artifact && parsed.checkpointN === cp.cp;
        })
        .sort(bySourceOrder))
        L.push(`- verification [${cAlias(row.citationId)}] ${oneLine(row.text)}`);
    }

    const unresolvedEvidence = rowsForArtifact(criterionEvidence, artifact).filter(
      (row) => !matchedEvidenceIds.has(row.citationId)
    );
    const unresolvedVerification = rowsForArtifact(verification, artifact).filter((row) => {
      const parsed = parseCitationId(row.citationId);
      return !checkpoints.some((cp) => parsed?.checkpointN === cp.cp);
    });
    if (unresolvedEvidence.length > 0 || unresolvedVerification.length > 0) {
      L.push('');
      L.push('### Records with unresolved captured links');
      L.push('');
      for (const row of unresolvedEvidence)
        L.push(
          `- evidence [${cAlias(row.citationId)}]${checkpointSuffix(row)} ${oneLine(row.text)} — no acceptance criterion in scope`
        );
      for (const row of unresolvedVerification)
        L.push(
          `- verification [${cAlias(row.citationId)}]${checkpointSuffix(row)} ${oneLine(row.text)} — no checkpoint in scope`
        );
    }

    const evaluators = rowsForArtifact(evaluatorRuns, artifact);
    if (evaluators.length > 0) {
      L.push('');
      L.push('### Evaluators');
      L.push('');
      L.push(`Evaluator summary: ${evaluatorCounts(evaluators)}`);
      for (const row of partitionAccountEvaluatorRuns(evaluators).expanded) {
        const metadata = row.evaluator;
        L.push(
          `- evaluator [${cAlias(row.citationId)}] ${oneLine(metadata.evaluator_ref)} — run ${metadata.run_status.toUpperCase()} · verdict ${(metadata.verdict ?? 'none').toUpperCase()} · severity ${metadata.severity.toUpperCase()} · disposition ${metadata.disposition ?? 'unrecorded'} — ${oneLine(metadata.summary) || '(no summary)'}`
        );
      }
    }
  }

  // Malformed legacy ids cannot be placed locally, but protected content is
  // still never dropped. Healthy schema-4 builds never enter this fallback.
  const unscopedRows = [
    ...c.planSteps.filter((row) => artifactOf(row) === null),
    ...c.nonGoals.filter((row) => artifactOf(row) === null),
    ...planDecisions
      .filter((row) => artifactOf(row) === null)
      .flatMap((decision) => [decision, ...decision.alternatives]),
    ...c.acceptanceCriteria.filter(
      (row) => artifactOf(row) === null && !renderableStepIds.has(row.parent)
    ),
    ...criterionEvidence.filter(
      (row) =>
        artifactOf(row) === null &&
        (row.parent === undefined || !renderableCriterionIds.has(row.parent))
    ),
    ...verification.filter((row) => artifactOf(row) === null),
    ...partitionAccountEvaluatorRuns(evaluatorRuns.filter((row) => artifactOf(row) === null))
      .expanded,
  ];
  if (unscopedRows.length > 0) {
    L.push('');
    L.push('## Records with unparseable provenance');
    L.push('');
    for (const row of unscopedRows.sort(bySourceOrder))
      L.push(`- [${cAlias(row.citationId)}] ${oneLine(row.text)}`);
  }

  L.push('');
  L.push('## Claim ledger');
  L.push('');
  if (c.ledger.length === 0) L.push('(none)');
  const ledgerGroups = new Map<string, typeof c.ledger>();
  for (const entry of c.ledger) {
    const key = `${entry.kind}\u0000${entry.status}`;
    const rows = ledgerGroups.get(key) ?? [];
    rows.push(entry);
    ledgerGroups.set(key, rows);
  }
  for (const [, rows] of [...ledgerGroups.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    const first = rows[0]!;
    L.push(`### ${first.kind} · ${first.status} (${rows.length})`);
    L.push('');
    const registeredExplanation = CLAIM_LEDGER_SHARED_EXPLANATIONS[first.kind];
    const sharedSuffix = registeredExplanation === undefined ? null : ` ${registeredExplanation}`;
    const shareExplanation =
      rows.length > 1 &&
      sharedSuffix !== null &&
      rows.every((entry) => oneLine(entry.message).endsWith(sharedSuffix));
    if (shareExplanation) {
      L.push(`Shared explanation (all rows): ${registeredExplanation}`);
      L.push('');
    }
    for (const entry of rows) {
      const sourceMessage = oneLine(entry.message);
      const messageWithoutSharedExplanation = shareExplanation
        ? sourceMessage.slice(0, -sharedSuffix!.length)
        : sourceMessage;
      const message = replaceCheckpointReferences(messageWithoutSharedExplanation);
      const annotations = [
        ...(entry.flagOnly === true ? ['flag-only group'] : []),
        ...(entry.memberCount !== undefined ? [`${entry.memberCount} members`] : []),
      ];
      L.push(
        `- [${cAlias(entry.id)}]${annotations.length > 0 ? ` (${annotations.join(' · ')})` : ''} ${message}`
      );

      const anchors = entry.anchors
        .filter((anchor) => {
          const displayed = replaceCheckpointReferences(anchor);
          return !hasExactReference(message, anchor) && !hasExactReference(message, displayed);
        })
        .map(replaceCheckpointReferences);
      const omitted =
        entry.anchorsOmitted ??
        Math.max(0, (entry.anchorTotal ?? entry.anchors.length) - entry.anchors.length);
      if (anchors.length > 0 || omitted > 0) {
        const projectionOmission =
          omitted > 0
            ? `${omitted} additional anchor${omitted === 1 ? '' : 's'} projection-omitted`
            : '';
        L.push(
          `  anchors: ${anchors.length > 0 ? anchors.join(', ') : '(none retained)'}${projectionOmission.length > 0 ? ` · ${projectionOmission}` : ''}`
        );
      }
      // Nested citation references are NOT displayed: every
      // [bracketed] id in this payload is citable, and nothing else is shown
      // as an id — the renderer and validator share accountCitableIds.
      for (const [id, text] of Object.entries(entry.citedFallback))
        L.push(`  cited [${cAlias(id)}] "${oneLine(text)}"`);
    }
    L.push('');
  }
  // The account lane specializes in captured causal history. The projection
  // deliberately retains implicated/risk selections for reversibility and
  // diagnostics. The duplicated changed-file inventory is likewise retained
  // there, but not rendered beside THIS RUN's authoritative scope counts.
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

type MintResult =
  | {
      ok: true;
      runId: string;
      runDir: string;
      input_shas: Record<string, string>;
    }
  | { ok: false; message: string };

async function mintRunUnderReviewStateLock(
  root: string,
  branch: string,
  args: ReviewArgs,
  verifyLease: VerifyReviewLease
): Promise<MintResult> {
  const executionProfile = parseExecutionProfile(args.executionProfileJson);
  if (!executionProfile.ok) return { ok: false, message: executionProfile.message };
  const reviewDir = reviewDirFor(root, branch);
  await requireReviewStateVersion(reviewDir);
  const snapshots: Partial<Record<keyof typeof INPUT_FILES, Buffer>> = {};
  for (const [key, file] of Object.entries(INPUT_FILES) as [keyof typeof INPUT_FILES, string][]) {
    try {
      snapshots[key] = await readFile(path.join(reviewDir, file));
    } catch {
      return {
        ok: false,
        message: `${file} is not built for this branch; run \`review dossier --branch ${branch}\` first`,
      };
    }
  }
  const forensicInput = parseForensicInputJson(
    snapshots.forensic_input!.toString('utf8'),
    `${reviewDir}/${INPUT_FILES.forensic_input}`
  );
  const projection = parseAccountProjectionJson(
    snapshots.projection!.toString('utf8'),
    `${reviewDir}/${INPUT_FILES.projection}`
  );
  const latencyInputBytes = Buffer.byteLength(forensicInput.diff, 'utf8');
  if (forensicInput.metrics.eligibleDiffBytes !== latencyInputBytes)
    return {
      ok: false,
      message:
        `forensic input byte accounting is inconsistent: metrics.eligibleDiffBytes=${forensicInput.metrics.eligibleDiffBytes}, ` +
        `actual UTF-8 diff bytes=${latencyInputBytes}`,
    };
  latencyProfileFor(latencyInputBytes);
  const runId = randomUUID();
  const runDir = runDirFor(root, branch, runId);
  await verifyLease();
  await mkdir(runDir, { recursive: true });
  const input_shas: Record<string, string> = {};
  for (const [key, file] of Object.entries(INPUT_FILES) as [keyof typeof INPUT_FILES, string][]) {
    const bytes = snapshots[key]!;
    input_shas[key] = sha16(bytes);
    await atomicWriteFile(path.join(runDir, file), bytes.toString('utf8'), root);
  }
  // Pin the coverage snapshot under the SAME immutability pattern when present.
  const covBytes = await readFile(path.join(reviewDir, COVERAGE_FILE)).catch(() => null);
  if (covBytes !== null) {
    input_shas.coverage = sha16(covBytes);
    await atomicWriteFile(path.join(runDir, COVERAGE_FILE), covBytes.toString('utf8'), root);
  }
  // Pin the unified diff under the same immutability pattern when present. Absent
  // on a degenerate scope or an older dossier — the model then installs without a
  // round-trip check (there are no segments to resolve in the degraded states).
  const diffBytes = await readFile(path.join(reviewDir, DIFF_FILE)).catch(() => null);
  if (diffBytes !== null) {
    input_shas.diff = sha16(diffBytes);
    await atomicWriteFile(path.join(runDir, DIFF_FILE), diffBytes.toString('utf8'), root);
  }
  await atomicWriteFile(
    path.join(runDir, LANE_MD_FILE.forensic),
    renderForensicRoutineMd(forensicInput),
    root
  );
  // The production mint ALWAYS serves the complete facts block. The parameter is
  // optional only so the existing unit call sites stay valid; "optional" must
  // never mean "absent in the path that matters", which is asserted by test.
  const fm = forensicInput.metrics;
  await atomicWriteFile(
    path.join(runDir, LANE_MD_FILE.account),
    renderAccountRoutineMd(projection, {
      runId,
      baseSha: forensicInput.baseSha ?? null,
      floorInputHash: projection.floor_input_hash,
      eligibleFiles: fm.eligibleFiles,
      eligibleDiffBytes: fm.eligibleDiffBytes,
      excludedFiles: fm.excludedFiles,
      unreviewableFiles: fm.unreviewableFiles,
      policyStubFiles: fm.policyStubFiles ?? (forensicInput.policyStubs ?? []).length,
      policyStubRows:
        fm.policyStubRows ??
        (forensicInput.policyStubs ?? []).reduce((n, x) => n + x.adds + x.dels, 0),
      latencyTier: latencyTierFor(fm.eligibleDiffBytes),
    }),
    root
  );
  const run: TwolaneRunFile = {
    schema_version: TWOLANE_RUN_SCHEMA_VERSION,
    run_id: runId,
    branch,
    mode: 'routine',
    created_at: new Date().toISOString(),
    input_shas,
    slice_state: freshSliceRunState(),
    lane_inputs_served: {},
    attempts: [],
    account_lineage: null,
    latency_input_bytes: latencyInputBytes,
    runtime_identity: args.runtimeIdentity ?? null,
    execution_profile: executionProfile.profile,
    finalized: null,
  };
  await verifyLease();
  await writeRunFile(root, runDir, run);
  return { ok: true, runId, runDir, input_shas };
}

async function mintRun(root: string, branch: string, args: ReviewArgs): Promise<MintResult> {
  return withReviewStateLock(root, branch, (verifyLease) =>
    mintRunUnderReviewStateLock(root, branch, args, verifyLease)
  );
}

async function runStart(args: ReviewArgs, root: string, branch: string): Promise<number> {
  const minted = await mintRun(root, branch, args);
  if (!minted.ok) return fail(args, 'start', minted.message, 2);
  if (args.json) {
    emit({
      ok: true,
      run_id: minted.runId,
      branch,
      mode: 'routine',
      schema_version: TWOLANE_RUN_SCHEMA_VERSION,
      lanes: ['forensic', 'account'],
      input_shas: minted.input_shas,
      run_dir: path.relative(root, minted.runDir),
    });
  } else {
    process.stdout.write(
      `run ${minted.runId} minted under ${path.relative(root, minted.runDir)}\n`
    );
  }
  return 0;
}

function parseLane(value: string | undefined): Lane | null {
  return value === 'account' || value === 'forensic' ? value : null;
}

/** Read + mark-served + describe one lane's input (no ordering check here). */
async function serveLaneEnvelope(
  root: string,
  branch: string,
  runId: string,
  runDir: string,
  lane: Lane
): Promise<{
  contract: Record<string, unknown>;
  payload_path: string;
  payload_sha: string;
  payload_bytes: number;
}> {
  const payloadPath = path.join(runDir, LANE_MD_FILE[lane]);
  const bytes = await readFile(payloadPath);
  await withTwolaneRunLock(root, branch, runId, async (verifyLeases) => {
    const fresh = await readTwolaneRunFile(runDir);
    if (fresh.lane_inputs_served[lane] === undefined) {
      fresh.lane_inputs_served[lane] = new Date().toISOString();
      await verifyLeases();
      await writeRunFile(root, runDir, fresh);
    }
  });
  return {
    contract: LANE_CONTRACTS[lane],
    payload_path: path.relative(root, payloadPath),
    payload_sha: sha16(bytes),
    payload_bytes: bytes.length,
  };
}

async function runLaneInput(args: ReviewArgs, root: string, branch: string): Promise<number> {
  const lane = parseLane(args.lane);
  if (lane === null) return fail(args, 'lane-input', '--lane must be `account` or `forensic`', 2);
  if (!args.runId) return fail(args, 'lane-input', '--run <run-id> is required', 2);
  const runDir = runDirFor(root, branch, args.runId);
  let run: TwolaneRunFile;
  try {
    run = await readTwolaneRunFile(runDir);
  } catch (error) {
    return fail(
      args,
      'lane-input',
      `run ${args.runId} is not readable: ${(error as Error).message}`,
      1
    );
  }
  if (lane === 'account' && !forensicTerminal(run.slice_state))
    return fail(args, 'lane-input', `TWOLANE_ROUTINE_ORDER: ${ROUTINE_ORDER_MESSAGE}`, 1);
  const served = await serveLaneEnvelope(root, branch, args.runId, runDir, lane);
  const envelope = { ok: true, run_id: run.run_id, lane, ...served };
  if (args.json) emit(envelope);
  else
    process.stdout.write(
      `lane ${lane} input: ${envelope.payload_path} (${envelope.payload_bytes} bytes, sha ${envelope.payload_sha})\n`
    );
  return 0;
}

async function loadSliceInputs(
  runDir: string
): Promise<{ dossier: DossierV1; projection: AccountProjection; forensicInput: ForensicInput }> {
  const dossier = parseDossierV1Json(
    await readFile(path.join(runDir, INPUT_FILES.dossier), 'utf8'),
    `${runDir}/${INPUT_FILES.dossier}`
  );
  const projection = parseAccountProjectionJson(
    await readFile(path.join(runDir, INPUT_FILES.projection), 'utf8'),
    `${runDir}/${INPUT_FILES.projection}`
  );
  const forensicInput = parseForensicInputJson(
    await readFile(path.join(runDir, INPUT_FILES.forensic_input), 'utf8'),
    `${runDir}/${INPUT_FILES.forensic_input}`
  );
  return { dossier, projection, forensicInput };
}

/**
 * Load the pinned coverage snapshot for the composition. Absent (or unparseable)
 * → null, and composeStory finalizes as a labeled degraded ownership state
 * rather than fabricating a topology.
 */
async function loadCoverageSnapshot(runDir: string): Promise<CoverageInput | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(runDir, COVERAGE_FILE), 'utf8')) as {
      items?: CoverageInput['items'];
      summary?: CoverageInput['summary'];
    };
    if (raw.items === undefined || raw.summary === undefined) return null;
    return { items: raw.items, summary: raw.summary };
  } catch {
    return null;
  }
}

class PinnedDiffUnreadableError extends Error {}

/**
 * The run's pinned unified diff, or null when the run legitimately pinned none.
 *
 * Swallowing EVERY error to null would conflate two different cases: a
 * diff.patch that exists but cannot be read would skip Part-range validation
 * silently, indistinguishable from a run that pinned no diff at all.
 *
 * `input_shas.diff` is written at start only when a diff was actually pinned, so
 * it is an exact discriminator: pinned-but-unreadable is a hard failure;
 * never-pinned is a real state (degenerate scope, older dossier) that finalize
 * RECORDS rather than hides.
 */
async function loadPinnedDiff(runDir: string, pinned: boolean): Promise<string | null> {
  try {
    return await readFile(path.join(runDir, DIFF_FILE), 'utf8');
  } catch (error) {
    if (!pinned) return null;
    throw new PinnedDiffUnreadableError(
      `pinned diff (${DIFF_FILE}) is recorded in input_shas but unreadable, so Part ranges cannot be validated: ${(error as Error).message}`
    );
  }
}

/**
 * Every code `classifyFinalizeError` can emit. The public agreement test
 * iterates this list, so a code added to the classifier ships documented or
 * fails CI.
 */
export const TWOLANE_FINALIZE_ERROR_CODES = [
  'TWOLANE_EXECUTABLE_IDENTITY_DRIFT',
  'PINNED_DIFF_UNREADABLE',
  'STORY_MODEL_CATALOG_INVALID',
  'STORY_MODEL_PROJECTION_INVALID',
  'STORY_MODEL_RANGES_UNRESOLVED',
  'STORY_MODEL_INVARIANT',
  'PART_OWNERSHIP_INVARIANT',
  'STORY_MODEL_SCHEMA_INVALID',
  'STORY_COMPOSE_FAILED',
] as const;
export type TwolaneFinalizeErrorCode = (typeof TWOLANE_FINALIZE_ERROR_CODES)[number];

/**
 * Finalize failures are NOT interchangeable, and collapsing them all to
 * STORY_COMPOSE_FAILED told an operator only that "something in the engine
 * broke". Each code below points at a different thing to go look at; the
 * fallback keeps the old code so an unclassified failure is still parseable.
 */
function classifyFinalizeError(error: unknown): {
  code: TwolaneFinalizeErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ExecutableIdentityDriftError)
    return { code: 'TWOLANE_EXECUTABLE_IDENTITY_DRIFT', message };
  if (error instanceof PinnedDiffUnreadableError)
    return { code: 'PINNED_DIFF_UNREADABLE', message };
  if (error instanceof StoryReviewModelCatalogError)
    return { code: 'STORY_MODEL_CATALOG_INVALID', message };
  if (error instanceof StoryReviewModelProjectionError)
    return { code: 'STORY_MODEL_PROJECTION_INVALID', message };
  if (error instanceof StoryReviewModelRangeError)
    return { code: 'STORY_MODEL_RANGES_UNRESOLVED', message };
  if (error instanceof StoryReviewModelInvariantError)
    return { code: 'STORY_MODEL_INVARIANT', message };
  if (error instanceof PartOwnershipInvariantError)
    return { code: 'PART_OWNERSHIP_INVARIANT', message };
  if (error instanceof ZodError) return { code: 'STORY_MODEL_SCHEMA_INVALID', message };
  return { code: 'STORY_COMPOSE_FAILED', message };
}

class ExecutableIdentityDriftError extends Error {
  override readonly name = 'ExecutableIdentityDriftError';
}

interface SubmitFlags {
  lane: Lane;
  runId: string;
  isolation: DeclaredIsolation;
  raw: unknown;
  outerNormalizationCode: SubmissionNormalizationCode;
  rawSubmissionSha256: string;
  usageTokens: number | null;
  usageSource: string | null;
  runtimeIdentity: ExecutableIdentity | null;
}

async function parseSubmitFlags(
  args: ReviewArgs,
  verb: string
): Promise<{ ok: true; flags: SubmitFlags } | { ok: false; exit: number }> {
  const lane = parseLane(args.lane);
  if (lane === null)
    return { ok: false, exit: fail(args, verb, '--lane must be `account` or `forensic`', 2) };
  if (!args.runId) return { ok: false, exit: fail(args, verb, '--run <run-id> is required', 2) };
  const isolation = args.isolation as DeclaredIsolation | undefined;
  if (isolation === undefined || !ISOLATION_VALUES.includes(isolation))
    return {
      ok: false,
      exit: fail(
        args,
        verb,
        `--isolation must be one of: ${ISOLATION_VALUES.join(', ')} (the run record requires it)`,
        2
      ),
    };
  if (args.input === undefined)
    return { ok: false, exit: fail(args, verb, '--input <path> is required (`-` reads stdin)', 2) };
  let usageTokens: number | null = null;
  if (args.usageTokens !== undefined) {
    usageTokens = Number.parseInt(args.usageTokens, 10);
    if (!Number.isInteger(usageTokens) || usageTokens < 0)
      return {
        ok: false,
        exit: fail(args, verb, '--usage-tokens must be a non-negative integer', 2),
      };
  }
  const rawText =
    args.input === '-'
      ? await readStdinAll()
      : await readFile(args.input, 'utf8').catch(() => null);
  if (rawText === null)
    return { ok: false, exit: fail(args, verb, `--input ${args.input} is not readable`, 1) };
  // Invalid JSON still consumes an attempt and earns shape diagnostics. A
  // single JSON-string wrapper is normalized deterministically for every lane.
  const normalized = normalizeSubmission(rawText);
  return {
    ok: true,
    flags: {
      lane,
      runId: args.runId,
      isolation,
      raw: normalized.value,
      outerNormalizationCode: normalized.code,
      rawSubmissionSha256: normalized.raw_sha256,
      usageTokens,
      usageSource: args.usageSource ?? null,
      runtimeIdentity: args.runtimeIdentity ?? null,
    },
  };
}

const runtimeIdentityDrift = (
  expected: ExecutableIdentity | null,
  observed: ExecutableIdentity | null
): string | null => {
  if (expected === null) return null;
  if (observed === null)
    return 'the run pinned an executable identity, but this invocation supplied none';
  const expectedFingerprint = expected.runtimeFingerprintSha256;
  const observedFingerprint = observed.runtimeFingerprintSha256;
  return expectedFingerprint === observedFingerprint
    ? null
    : `run executable fingerprint ${expectedFingerprint} does not match current fingerprint ${observedFingerprint}`;
};

type SubmitOutcome =
  | { status: 'notfound'; message: string }
  | { status: 'sealed' }
  | { status: 'identity-drift'; message: string }
  | {
      status: 'done';
      accepted: boolean;
      diagnostics: { code: string; message: string }[];
      state: SliceRunState;
    };

async function performSubmit(
  root: string,
  branch: string,
  flags: SubmitFlags
): Promise<SubmitOutcome> {
  const runDir = runDirFor(root, branch, flags.runId);
  let outcome: SubmitOutcome = { status: 'sealed' };
  await withTwolaneRunLock(root, branch, flags.runId, async (verifyLeases) => {
    let run: TwolaneRunFile;
    try {
      run = await readTwolaneRunFile(runDir);
    } catch (error) {
      outcome = { status: 'notfound', message: (error as Error).message };
      return;
    }
    if (run.finalized !== null) {
      outcome = { status: 'sealed' };
      return;
    }
    const identityDrift = runtimeIdentityDrift(run.runtime_identity, flags.runtimeIdentity);
    if (identityDrift !== null) {
      outcome = { status: 'identity-drift', message: identityDrift };
      return;
    }
    if (flags.lane === 'account' && !forensicTerminal(run.slice_state)) {
      // Engine-enforced routine ordering: refused BEFORE the state machine,
      // so no attempt is consumed and no state changes.
      outcome = {
        status: 'done',
        accepted: false,
        diagnostics: [{ code: 'TWOLANE_ROUTINE_ORDER', message: ROUTINE_ORDER_MESSAGE }],
        state: run.slice_state,
      };
      return;
    }
    const { dossier, projection } = await loadSliceInputs(runDir);
    const ctx = sliceContext(dossier, projection, flags.lane);
    const normalizationCodes: RoutineNormalizationCode[] = [
      ...(flags.outerNormalizationCode === 'CLEAN_JSON' ? [] : [flags.outerNormalizationCode]),
    ];
    if (normalizationCodes.length === 0) normalizationCodes.push('CLEAN_JSON');
    const normalizationCode: RoutineNormalizationSummaryCode =
      normalizationCodes.length === 1 ? normalizationCodes[0]! : 'MULTIPLE_NORMALIZATIONS';
    const normalizedSubmissionSha256 = canonicalJsonSha256(flags.raw);
    const isRepair = run.slice_state.lanes[flags.lane].attempts >= 1;
    const submit = submitLane(run.slice_state, flags.lane, flags.raw, ctx, {
      routine: true,
      normalized: normalizationCodes.some((code) => code !== 'CLEAN_JSON'),
    });
    run.slice_state = submit.state;
    let compiledPayloadSha256: string | null = null;
    let acceptedEnvelopeSha256: string | null = null;
    if (submit.accepted && submit.payload !== null) {
      await verifyLeases();
      if (flags.lane === 'account') {
        const compiled = submit.payload as AccountPayload;
        compiledPayloadSha256 = canonicalJsonSha256(compiled);
        const diagnosticCodes = submit.state.lanes.account.diagnostics.map(
          (diagnostic) => diagnostic.code
        );
        const accepted: AcceptedAccountEnvelope = {
          schema_version: 1,
          normalization_code: normalizationCode,
          normalization_codes: normalizationCodes,
          normalized_authored: flags.raw as AuthoredAccountPayload,
          compiled_payload: compiled,
          inner: {
            raw_submission_sha256: flags.rawSubmissionSha256,
            normalized_authored_sha256: normalizedSubmissionSha256,
            compiled_payload_sha256: compiledPayloadSha256,
            diagnostic_codes: diagnosticCodes,
          },
        };
        acceptedEnvelopeSha256 = canonicalJsonSha256(accepted);
        run.account_lineage = {
          ...accepted.inner,
          accepted_envelope_sha256: acceptedEnvelopeSha256,
          normalization_code: accepted.normalization_code,
          normalization_codes: accepted.normalization_codes,
        };
        await atomicWriteFile(
          path.join(runDir, 'accepted-account.json'),
          `${JSON.stringify(accepted, null, 2)}\n`,
          root
        );
      } else {
        await atomicWriteFile(
          path.join(runDir, 'accepted-forensic.json'),
          `${JSON.stringify(submit.payload, null, 2)}\n`,
          root
        );
      }
    }
    run.attempts.push({
      lane: flags.lane,
      at: new Date().toISOString(),
      accepted: submit.accepted,
      is_repair: isRepair,
      declared_isolation: flags.isolation,
      diagnostic_codes: submit.diagnostics.map((d) => d.code),
      normalization_code: normalizationCode,
      normalization_codes: normalizationCodes,
      raw_submission_sha256: flags.rawSubmissionSha256,
      normalized_submission_sha256: normalizedSubmissionSha256,
      compiled_payload_sha256: compiledPayloadSha256,
      accepted_envelope_sha256: acceptedEnvelopeSha256,
      usage_tokens: flags.usageTokens,
      usage_source: flags.usageSource,
    });
    await verifyLeases();
    await writeRunFile(root, runDir, run);
    outcome = {
      status: 'done',
      accepted: submit.accepted,
      diagnostics: submit.diagnostics,
      state: submit.state,
    };
  });
  return outcome;
}

async function runLaneSubmit(args: ReviewArgs, root: string, branch: string): Promise<number> {
  const parsed = await parseSubmitFlags(args, 'lane-submit');
  if (!parsed.ok) return parsed.exit;
  const outcome = await performSubmit(root, branch, parsed.flags);
  if (outcome.status === 'notfound')
    return fail(
      args,
      'lane-submit',
      `run ${parsed.flags.runId} is not readable: ${outcome.message}`,
      1
    );
  if (outcome.status === 'sealed')
    return fail(
      args,
      'lane-submit',
      `run ${parsed.flags.runId} is finalized; submissions are sealed`,
      1
    );
  if (outcome.status === 'identity-drift')
    return fail(args, 'lane-submit', `TWOLANE_EXECUTABLE_IDENTITY_DRIFT: ${outcome.message}`, 1);
  const envelope = {
    ok: true,
    run_id: parsed.flags.runId,
    lane: parsed.flags.lane,
    accepted: outcome.accepted,
    diagnostics: outcome.diagnostics,
    state: {
      ...stateEnvelope(outcome.state),
    },
  };
  if (args.json) emit(envelope);
  else
    process.stdout.write(
      `lane ${parsed.flags.lane}: ${outcome.accepted ? 'accepted' : `rejected (${outcome.diagnostics.map((d) => d.code).join(', ') || 'no diagnostics'})`}\n`
    );
  return 0;
}

const laneIsolation = (
  attempts: readonly TwolaneAttemptRecord[],
  lane: Lane
): IsolationStatus | null => {
  const mine = attempts.filter((a) => a.lane === lane);
  if (mine.length === 0) return null;
  if (mine.some((a) => a.declared_isolation === 'sequential')) return 'SEQUENTIAL';
  if (mine.some((a) => a.declared_isolation === 'unknown')) return 'UNKNOWN';
  return 'SUBAGENT_FRESH';
};

const aggregateIsolation = (perLane: Record<Lane, IsolationStatus | null>): IsolationStatus => {
  const present = Object.values(perLane).filter((v): v is IsolationStatus => v !== null);
  if (present.length === 0) return 'UNKNOWN';
  if (present.includes('SEQUENTIAL')) return 'SEQUENTIAL';
  if (present.includes('UNKNOWN')) return 'UNKNOWN';
  return 'SUBAGENT_FRESH';
};

async function runRunShow(args: ReviewArgs, root: string, branch: string): Promise<number> {
  if (!args.runId) return fail(args, 'run-show', '--run <run-id> is required', 2);
  const runDir = runDirFor(root, branch, args.runId);
  let run: TwolaneRunFile;
  try {
    run = await readTwolaneRunFile(runDir);
  } catch (error) {
    return fail(
      args,
      'run-show',
      `run ${args.runId} is not readable: ${(error as Error).message}`,
      1
    );
  }
  const envelope = {
    ok: true,
    run_id: run.run_id,
    branch: run.branch,
    mode: run.mode,
    created_at: run.created_at,
    state: stateEnvelope(run.slice_state),
    forensic_terminal: forensicTerminal(run.slice_state),
    lane_inputs_served: run.lane_inputs_served,
    attempts: run.attempts,
    finalized: run.finalized,
  };
  if (args.json) emit(envelope);
  else
    process.stdout.write(
      `run ${run.run_id}: account ${run.slice_state.lanes.account.outcome}, forensic ${run.slice_state.lanes.forensic.outcome}, repair credit account=${run.slice_state.lanes.account.repairCredit} forensic=${run.slice_state.lanes.forensic.repairCredit}, ${run.finalized === null ? 'open' : `finalized ${run.finalized.outcome}`}\n`
    );
  return 0;
}

type FinalizeOutcome =
  | { status: 'notfound'; message: string }
  | {
      status: 'already';
      outcome: string;
      at: string;
      record: Record<string, unknown> | null;
      runDir: string;
      currentStory: PublishCurrentStoryResult | null;
    }
  | {
      status: 'current-install-failed';
      outcome: string;
      at: string;
      message: string;
      runDir: string;
    }
  | {
      status: 'done';
      record: Record<string, unknown>;
      markdown: string | null;
      runDir: string;
      currentStory: PublishCurrentStoryResult | null;
    };

export interface TwolaneOwnershipSummary {
  label: ComposedStory['ownership']['label'];
  reviewable_rows: number;
  attributed_rows: number;
  /** Stored at the composed model's full numeric precision; round only for display. */
  attributed_pct: number;
  ambiguous_rows: number;
  contested_rows: number;
  unattributed_rows: number;
  missing_boundary_checkpoints: number;
}

/** Project only the composed output's authoritative ownership accounting. */
export const ownershipSummaryFromComposed = (composed: ComposedStory): TwolaneOwnershipSummary => {
  const metrics = composed.ownership.metrics;
  const classifiedRows =
    metrics.attributedRows +
    metrics.ambiguousRows +
    metrics.contestedRows +
    metrics.unattributedRows;
  if (classifiedRows !== metrics.reviewableRows) {
    throw new Error(
      `ownership summary partition mismatch: reviewable=${metrics.reviewableRows}, ` +
        `attributed=${metrics.attributedRows}, ambiguous=${metrics.ambiguousRows}, ` +
        `contested=${metrics.contestedRows}, unattributed=${metrics.unattributedRows}`
    );
  }
  return {
    label: composed.ownership.label,
    reviewable_rows: metrics.reviewableRows,
    attributed_rows: metrics.attributedRows,
    attributed_pct: metrics.attributedPct,
    ambiguous_rows: metrics.ambiguousRows,
    contested_rows: metrics.contestedRows,
    unattributed_rows: metrics.unattributedRows,
    missing_boundary_checkpoints: composed.ownership.missingBoundaryCheckpoints,
  };
};

async function performFinalize(
  root: string,
  branch: string,
  runId: string,
  runtimeIdentity: ExecutableIdentity | null
): Promise<FinalizeOutcome> {
  const runDir = runDirFor(root, branch, runId);
  let final: FinalizeOutcome = { status: 'notfound', message: 'finalize did not run' };
  await withTwolaneRunLock(root, branch, runId, async (verifyLeases) => {
    let run: TwolaneRunFile;
    let markdown: string | null = null;
    try {
      run = await readTwolaneRunFile(runDir);
    } catch (error) {
      final = { status: 'notfound', message: (error as Error).message };
      return;
    }
    if (run.finalized !== null) {
      let record: Record<string, unknown> | null = null;
      try {
        record = JSON.parse(await readFile(path.join(runDir, RUN_RECORD_FILE), 'utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        // Publication revalidation below will report the terminal inconsistency
        // with a named current-Story install failure.
      }
      final = {
        status: 'already',
        outcome: run.finalized.outcome,
        at: run.finalized.at,
        record,
        runDir,
        currentStory: null,
      };
      return;
    }
    const identityDrift = runtimeIdentityDrift(run.runtime_identity, runtimeIdentity);
    if (identityDrift !== null) throw new ExecutableIdentityDriftError(identityDrift);
    const readAccepted = async <T>(lane: Lane): Promise<T | null> => {
      if (!run.slice_state.lanes[lane].accepted) return null;
      const accepted = JSON.parse(
        await readFile(path.join(runDir, `accepted-${lane}.json`), 'utf8')
      ) as T | AcceptedAccountEnvelope;
      return (
        lane === 'account' ? (accepted as AcceptedAccountEnvelope).compiled_payload : accepted
      ) as T;
    };
    const account = await readAccepted<AccountPayload>('account');
    const forensic = await readAccepted<ForensicPayload>('forensic');
    const outcome: 'FULL' | 'DEGRADED' | 'FAILED' =
      account !== null && forensic !== null
        ? 'FULL'
        : account !== null || forensic !== null
          ? 'DEGRADED'
          : 'FAILED';
    let rangeValidation: 'PERFORMED' | 'SKIPPED_NO_PINNED_DIFF' | 'NOT_APPLICABLE' =
      'NOT_APPLICABLE';
    let semanticAnchorPreparation = prepareSemanticAnchorInput({
      runId: run.run_id,
      storyModel: null,
      storyModelBytes: null,
      accountProjection: null,
      accountProjectionBytes: null,
      coverage: null,
      coverageBytes: null,
      pinnedDiffText: null,
      forensicInput: null,
      forensicInputBytes: null,
      accountLineage: null,
    });
    let semanticAnchorReceiptPersisted = false;
    let ownershipSummary: TwolaneOwnershipSummary | null = null;
    let outputs: {
      review_md: string;
      brief_json: string;
      composed_story: string;
      story_review_model: string;
      story_review_model_sha256: string;
      ownership_label: string;
    } | null = null;
    if (outcome !== 'FAILED') {
      const { dossier, projection, forensicInput } = await loadSliceInputs(runDir);
      const coverage = await loadCoverageSnapshot(runDir);
      const composed = composeStory({ account, forensic, projection, dossier, coverage });
      ownershipSummary = ownershipSummaryFromComposed(composed);
      const rendered = renderSlice({
        dossier,
        projection,
        merge: composed.merge,
        composed,
        accountPresent: account !== null,
        forensicPresent: forensic !== null,
        policyStubs: forensicInput.policyStubs,
      });
      // VALIDATE EVERY OUTPUT BEFORE THE FIRST WRITE.
      //
      // Deliberately not called "atomic finalization": a failure in one of the
      // writes below can still leave a partial set on disk, and real multi-file
      // atomicity needs a transaction or a terminal marker that consumers
      // honour. What this DOES guarantee is validate-before-write: validating
      // the story model inside its own write call, which runs LAST, would let an
      // unresolved Part range throw with review.md and brief.json already
      // written and the run reporting "not finalized" beside them.
      const diffText = await loadPinnedDiff(runDir, run.input_shas.diff !== undefined);
      const model = projectStoryReviewModel(composed, projection);
      const modelBytes = serializeStoryReviewModelForInstall({
        model,
        ...(diffText !== null ? { diffText } : {}),
      });
      // Whether the round-trip actually ran is RECORDED, not inferred. A skip is
      // a legitimate state; an unrecorded skip would claim a validation that was
      // silently not performed.
      rangeValidation = diffText !== null ? 'PERFORMED' : 'SKIPPED_NO_PINNED_DIFF';

      // Preparation is a deterministic, derived convenience for a later,
      // explicitly requested semantic-anchor pass. It is deliberately outside
      // the core validity boundary: missing coverage, an oversized complete
      // payload, or an implementation/write failure is recorded in its own
      // receipt and NEVER invalidates the accepted Story review.
      let projectionBytes: string | null = null;
      let coverageBytes: string | null = null;
      let forensicInputBytes: string | null = null;
      try {
        projectionBytes = await readFile(path.join(runDir, INPUT_FILES.projection), 'utf8');
        coverageBytes = await readFile(path.join(runDir, COVERAGE_FILE), 'utf8').catch(() => null);
        forensicInputBytes = await readFile(path.join(runDir, INPUT_FILES.forensic_input), 'utf8');
        semanticAnchorPreparation = prepareSemanticAnchorInput({
          runId: run.run_id,
          storyModel: model,
          storyModelBytes: modelBytes,
          accountProjection: projection,
          accountProjectionBytes: projectionBytes,
          coverage,
          coverageBytes,
          pinnedDiffText: diffText,
          forensicInput,
          forensicInputBytes,
          accountLineage:
            run.account_lineage === null
              ? null
              : {
                  acceptedEnvelopeSha256: run.account_lineage.accepted_envelope_sha256,
                  compiledPayloadSha256: run.account_lineage.compiled_payload_sha256,
                },
        });
      } catch (error) {
        if (error instanceof ArtifactLockLeaseLostError) throw error;
        semanticAnchorPreparation = unavailableSemanticAnchorPreparation(
          run.run_id,
          'PREPARATION_FAILED',
          error instanceof Error ? error.message : String(error),
          {
            storyModel: model,
            storyModelBytes: modelBytes,
            accountProjection: projection,
            accountProjectionBytes: projectionBytes,
            coverage,
            coverageBytes,
            pinnedDiffText: diffText,
            forensicInput,
            forensicInputBytes,
            accountLineage:
              run.account_lineage === null
                ? null
                : {
                    acceptedEnvelopeSha256: run.account_lineage.accepted_envelope_sha256,
                    compiledPayloadSha256: run.account_lineage.compiled_payload_sha256,
                  },
          }
        );
      }

      await verifyLeases();
      await atomicWriteFile(path.join(runDir, 'review.md'), rendered.markdown, root);
      await atomicWriteFile(
        path.join(runDir, 'brief.json'),
        `${JSON.stringify(rendered.brief, null, 2)}\n`,
        root
      );
      await atomicWriteFile(
        path.join(runDir, COMPOSED_STORY_FILE),
        `${JSON.stringify(composed, null, 2)}\n`,
        root
      );
      await atomicWriteFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), modelBytes, root);
      outputs = {
        review_md: 'review.md',
        brief_json: 'brief.json',
        composed_story: COMPOSED_STORY_FILE,
        story_review_model: STORY_REVIEW_MODEL_FILE,
        story_review_model_sha256: createHash('sha256').update(modelBytes).digest('hex'),
        ownership_label: composed.ownership.label,
      };
      markdown = rendered.markdown;
    }
    // Persist the derived input after every core output has succeeded. An I/O
    // failure here is demoted into an UNAVAILABLE receipt; the review remains
    // finalizable and the run record remains the authoritative disclosure.
    const persistSemanticPreparation = async (
      preparation: SemanticAnchorPreparation
    ): Promise<SemanticAnchorPreparation> => {
      try {
        await verifyLeases();
        if (preparation.payload !== null) {
          await atomicWriteFile(
            path.join(runDir, SEMANTIC_ANCHOR_INPUT_FILE),
            preparation.payload,
            root
          );
        }
        await atomicWriteFile(
          path.join(runDir, SEMANTIC_ANCHOR_RECEIPT_FILE),
          `${JSON.stringify(preparation.receipt, null, 2)}\n`,
          root
        );
        semanticAnchorReceiptPersisted = true;
        return preparation;
      } catch (error) {
        if (error instanceof ArtifactLockLeaseLostError) throw error;
        // A receipt failure after the payload write must not leave an orphaned
        // model input that looks usable. Non-READY preparation retains no file.
        await verifyLeases();
        await rm(
          reviewEntryPath(root, path.join(runDir, SEMANTIC_ANCHOR_INPUT_FILE), 'review run file'),
          { force: true }
        ).catch(() => {});
        const failed: SemanticAnchorPreparation = {
          payload: null,
          items: preparation.items,
          blockCatalog: preparation.blockCatalog,
          receipt: {
            ...preparation.receipt,
            status: 'UNAVAILABLE',
            reason: 'PREPARED_INPUT_WRITE_FAILED',
            error_message: error instanceof Error ? error.message : String(error),
            payload_file: null,
          },
        };
        try {
          await verifyLeases();
          await atomicWriteFile(
            path.join(runDir, SEMANTIC_ANCHOR_RECEIPT_FILE),
            `${JSON.stringify(failed.receipt, null, 2)}\n`,
            root
          );
          semanticAnchorReceiptPersisted = true;
        } catch (receiptError) {
          if (receiptError instanceof ArtifactLockLeaseLostError) throw receiptError;
          semanticAnchorReceiptPersisted = false;
        }
        return failed;
      }
    };
    semanticAnchorPreparation = await persistSemanticPreparation(semanticAnchorPreparation);
    const finalizedAt = new Date();
    const elapsedMs = Math.max(0, finalizedAt.getTime() - Date.parse(run.created_at));
    const latency = latencyProfileFor(run.latency_input_bytes);
    const perLane: Record<Lane, IsolationStatus | null> = {
      account: laneIsolation(run.attempts, 'account'),
      forensic: laneIsolation(run.attempts, 'forensic'),
    };
    const usageEntries = run.attempts
      .filter((a) => a.usage_tokens !== null)
      .map((a) => ({ lane: a.lane, at: a.at, tokens: a.usage_tokens, source: a.usage_source }));
    const record: Record<string, unknown> = {
      // run-record-v1.json is a DISTINCT contract from the run file: the
      // strictness cut bumped the run file to schema 2, but the record's
      // shape is unchanged and its readers pin literal 1.
      schema_version: TWOLANE_RUN_RECORD_SCHEMA_VERSION,
      run_id: run.run_id,
      branch: run.branch,
      mode: run.mode,
      created_at: run.created_at,
      finalized_at: finalizedAt.toISOString(),
      elapsed_ms: elapsedMs,
      latency_input_bytes: latency.latency_input_bytes,
      latency_tier: latency.latency_tier,
      latency_budget_ms: latency.latency_budget_ms,
      latency_status: elapsedMs <= latency.latency_budget_ms ? 'PASS' : 'MISSED',
      runtime_identity: run.runtime_identity,
      execution_profile: run.execution_profile,
      outcome,
      submission_count: run.attempts.length,
      repairs_used:
        2 -
        run.slice_state.lanes.account.repairCredit -
        run.slice_state.lanes.forensic.repairCredit,
      repairs_by_lane: {
        account: 1 - run.slice_state.lanes.account.repairCredit,
        forensic: 1 - run.slice_state.lanes.forensic.repairCredit,
      },
      lane_inputs_served: run.lane_inputs_served,
      attempts: run.attempts,
      isolation: { per_lane: perLane, aggregate: aggregateIsolation(perLane) },
      usage:
        usageEntries.length > 0
          ? { status: 'HOST_REPORTED', entries: usageEntries }
          : { status: 'UNKNOWN', entries: [] },
      input_shas: run.input_shas,
      range_validation: rangeValidation,
      ownership_summary: ownershipSummary,
      account_lineage: run.account_lineage,
      outputs,
      semantic_anchor_input: {
        ...semanticAnchorPreparation.receipt,
        receipt_file: semanticAnchorReceiptPersisted ? SEMANTIC_ANCHOR_RECEIPT_FILE : null,
      },
    };
    await verifyLeases();
    await atomicWriteFile(
      path.join(runDir, RUN_RECORD_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      root
    );
    run.finalized = { at: finalizedAt.toISOString(), outcome };
    await verifyLeases();
    await writeRunFile(root, runDir, run);
    final = { status: 'done', record, markdown, runDir, currentStory: null };
  });
  // `withLock` invokes the callback synchronously from TypeScript's point of
  // view, so control-flow analysis cannot see the assignments made inside it.
  let resolvedFinal = final as FinalizeOutcome;
  if (
    (resolvedFinal.status === 'done' && resolvedFinal.record.outputs !== null) ||
    (resolvedFinal.status === 'already' && resolvedFinal.outcome !== 'FAILED')
  ) {
    try {
      const currentStory = await publishCurrentStoryForRun({
        reviewDir: reviewDirFor(root, branch),
        locksDir: path.join(root, '.orcaops', 'tmp', 'locks'),
        containmentRoot: root,
        branch,
        runId,
      });
      resolvedFinal = { ...resolvedFinal, currentStory };
    } catch (error) {
      resolvedFinal = {
        status: 'current-install-failed',
        outcome:
          resolvedFinal.status === 'done'
            ? String(resolvedFinal.record.outcome)
            : String(resolvedFinal.outcome),
        at:
          resolvedFinal.status === 'done'
            ? String(resolvedFinal.record.finalized_at)
            : String(resolvedFinal.at),
        message: error instanceof Error ? error.message : String(error),
        runDir,
      };
    }
  }
  return resolvedFinal;
}

const finalizeFiles = (record: Record<string, unknown>): string[] => [
  RUN_RECORD_FILE,
  ...(record.outputs === null
    ? []
    : ['review.md', 'brief.json', COMPOSED_STORY_FILE, STORY_REVIEW_MODEL_FILE]),
  ...(() => {
    const prepared = record.semantic_anchor_input as
      | { receipt_file?: string | null; payload_file?: string | null }
      | undefined;
    return [prepared?.receipt_file, prepared?.payload_file].filter(
      (file): file is string => typeof file === 'string'
    );
  })(),
];

const semanticAnchorResponse = (
  root: string,
  runDir: string,
  record: Record<string, unknown>
): Record<string, unknown> => {
  const prepared = record.semantic_anchor_input as Record<string, unknown>;
  const qualify = (file: unknown): string | null =>
    typeof file === 'string' ? path.relative(root, path.join(runDir, file)) : null;
  return {
    status: prepared.status,
    reason: prepared.reason,
    error_message: prepared.error_message,
    payload_path: qualify(prepared.payload_file),
    receipt_path: qualify(prepared.receipt_file),
    payload_hash: prepared.payload_sha256,
    payload_bytes: prepared.payload_bytes,
    estimated_input_tokens: prepared.estimated_input_tokens,
    estimated_minimum_output_tokens: prepared.estimated_minimum_output_tokens,
    eligible_citation_count: prepared.eligible_citation_count,
  };
};

async function runFinalize(args: ReviewArgs, root: string, branch: string): Promise<number> {
  if (!args.runId) return fail(args, 'finalize', '--run <run-id> is required', 2);
  let final: Awaited<ReturnType<typeof performFinalize>>;
  try {
    final = await performFinalize(root, branch, args.runId, args.runtimeIdentity ?? null);
  } catch (error) {
    const { code, message } = classifyFinalizeError(error);
    return fail(
      args,
      'finalize',
      `${code}: finalize failed after lane acceptance — ${message}. The run is not finalized; finalize is retryable once the engine state is fixed.`,
      1
    );
  }
  if (final.status === 'notfound')
    return fail(args, 'finalize', `run ${args.runId} is not readable: ${final.message}`, 1);
  if (final.status === 'current-install-failed') {
    const message = `run ${args.runId} is terminal (${final.outcome} at ${final.at}), but the authoritative current Story could not be installed: ${final.message}. Re-run finalize to repair the pointer.`;
    if (args.json)
      emit({
        ok: false,
        error: {
          verb: 'review finalize',
          code: CURRENT_STORY_INSTALL_FAILED,
          message,
          run_finalized: true,
          retry: `orcaops review finalize --branch ${branch} --run ${args.runId}`,
        },
      });
    else process.stderr.write(`review finalize: ${CURRENT_STORY_INSTALL_FAILED}: ${message}\n`);
    return 1;
  }
  if (final.status === 'already') {
    if (final.outcome === 'FAILED')
      return fail(
        args,
        'finalize',
        `run ${args.runId} is already finalized FAILED (${final.at}); no Story output exists to publish`,
        1
      );
    if (args.json)
      emit({
        ok: true,
        status: 'already-finalized',
        run_id: args.runId,
        outcome: final.outcome,
        finalized_at: final.at,
        current_story: final.currentStory,
      });
    else
      process.stdout.write(
        `run ${args.runId} was already finalized (${final.outcome} at ${final.at}); current Story pointer verified\n`
      );
    return 0;
  }
  if (args.json) {
    emit({
      ok: true,
      run_id: args.runId,
      outcome: final.record.outcome,
      run_dir: path.relative(root, final.runDir),
      files: finalizeFiles(final.record),
      ownership_summary: final.record.ownership_summary,
      semantic_anchor: semanticAnchorResponse(root, final.runDir, final.record),
      current_story: final.currentStory,
      run_record: final.record,
    });
  } else if (final.markdown !== null) {
    process.stdout.write(final.markdown);
  } else {
    process.stdout.write(
      `run ${args.runId} finalized: ${String(final.record.outcome)} (no lane accepted)\n`
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Composite routine verbs: deterministic cycle-time
// consolidation — the same machinery, fewer host turns, still model-free.
// ---------------------------------------------------------------------------

/**
 * `routine-start` (the floor + dossier are built by the dispatcher in run.ts
 * before this): mint the run and serve the forensic input in one envelope.
 */
async function runRoutineStart(args: ReviewArgs, root: string, branch: string): Promise<number> {
  const minted = await mintRun(root, branch, args);
  if (!minted.ok) return fail(args, 'routine-start', minted.message, 2);
  const served = await serveLaneEnvelope(root, branch, minted.runId, minted.runDir, 'forensic');
  const envelope = {
    ok: true,
    run_id: minted.runId,
    branch,
    mode: 'routine',
    run_dir: path.relative(root, minted.runDir),
    input_shas: minted.input_shas,
    lane: 'forensic',
    ...served,
  };
  if (args.json) emit(envelope);
  else
    process.stdout.write(
      `run ${minted.runId}: forensic input at ${envelope.payload_path} (${envelope.payload_bytes} bytes)\n`
    );
  return 0;
}

/**
 * `routine-submit`: validate one lane submission; on forensic acceptance the
 * response carries the account input; on account acceptance the run is
 * finalized in the same call and the response carries the outcome + paths.
 * A rejected submission returns diagnostics — the same command accepts the
 * repaired payload.
 */
async function runRoutineSubmit(args: ReviewArgs, root: string, branch: string): Promise<number> {
  const parsed = await parseSubmitFlags(args, 'routine-submit');
  if (!parsed.ok) return parsed.exit;
  const flags = parsed.flags;
  const outcome = await performSubmit(root, branch, flags);
  if (outcome.status === 'notfound')
    return fail(
      args,
      'routine-submit',
      `run ${flags.runId} is not readable: ${outcome.message}`,
      1
    );
  if (outcome.status === 'sealed')
    return fail(
      args,
      'routine-submit',
      `run ${flags.runId} is finalized; submissions are sealed`,
      1
    );
  if (outcome.status === 'identity-drift')
    return fail(args, 'routine-submit', `TWOLANE_EXECUTABLE_IDENTITY_DRIFT: ${outcome.message}`, 1);
  const envelope: Record<string, unknown> = {
    ok: true,
    run_id: flags.runId,
    lane: flags.lane,
    accepted: outcome.accepted,
    diagnostics: outcome.diagnostics,
    state: stateEnvelope(outcome.state),
  };
  // Chaining is on TERMINALITY, not acceptance: a lane that
  // exhausts its repair still advances the program — the reviewer is never
  // stranded without a next step.
  const accountTerminal =
    outcome.state.lanes.account.accepted ||
    outcome.state.lanes.account.outcome === 'TERMINAL_REJECTED';
  if (flags.lane === 'forensic' && forensicTerminal(outcome.state)) {
    const runDir = runDirFor(root, branch, flags.runId);
    envelope.account = await serveLaneEnvelope(root, branch, flags.runId, runDir, 'account');
  }
  if (flags.lane === 'account' && accountTerminal) {
    // The submission is already accepted and persisted; a composition failure
    // past this point is an ENGINE defect, never a payload problem. It must
    // not surface as a submit rejection (the reviewer would resubmit and burn
    // SLICE_SUBMIT_AFTER_ACCEPT) — it reports as a parseable finalize-stage
    // failure with the acceptance state explicit, and `review finalize` stays
    // retryable.
    try {
      const final = await performFinalize(root, branch, flags.runId, flags.runtimeIdentity);
      if (final.status === 'done') {
        envelope.outcome = final.record.outcome;
        envelope.run_dir = path.relative(root, final.runDir);
        envelope.files = finalizeFiles(final.record);
        envelope.ownership_summary = final.record.ownership_summary;
        envelope.semantic_anchor = semanticAnchorResponse(root, final.runDir, final.record);
        envelope.current_story = final.currentStory;
        envelope.run_record = final.record;
      } else if (final.status === 'current-install-failed') {
        envelope.finalize_error = {
          code: CURRENT_STORY_INSTALL_FAILED,
          stage: 'current-story-install',
          lane_accepted: outcome.accepted,
          run_finalized: true,
          message: final.message,
          retry: `orcaops review finalize --branch ${branch} --run ${flags.runId}`,
        };
      }
    } catch (error) {
      envelope.finalize_error = {
        code: classifyFinalizeError(error).code,
        stage: 'finalize',
        lane_accepted: outcome.accepted,
        run_finalized: false,
        message: (error as Error).message,
        retry: `orcaops review finalize --branch ${branch} --run ${flags.runId}`,
      };
    }
  }
  if (args.json) emit(envelope);
  else
    process.stdout.write(
      `lane ${flags.lane}: ${outcome.accepted ? 'accepted' : `rejected (${outcome.diagnostics.map((d) => d.code).join(', ') || 'no diagnostics'})`}${envelope.outcome !== undefined ? ` — finalized ${String(envelope.outcome)}` : ''}\n`
    );
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const TWOLANE_RUN_VERBS = [
  'start',
  'lane-input',
  'lane-submit',
  'run-show',
  'finalize',
  'routine-start',
  'routine-submit',
] as const;

export async function runTwolaneRun(args: ReviewArgs, root: string): Promise<number> {
  const verb = args.sub ?? '';
  if (!args.branch) return fail(args, verb, '--branch is required', 2);
  try {
    if (verb === 'start') return await runStart(args, root, args.branch);
    if (verb === 'lane-input') return await runLaneInput(args, root, args.branch);
    if (verb === 'lane-submit') return await runLaneSubmit(args, root, args.branch);
    if (verb === 'run-show') return await runRunShow(args, root, args.branch);
    if (verb === 'finalize') return await runFinalize(args, root, args.branch);
    if (verb === 'routine-start') return await runRoutineStart(args, root, args.branch);
    if (verb === 'routine-submit') return await runRoutineSubmit(args, root, args.branch);
  } catch (error) {
    return fail(args, verb, (error as Error).message, 1);
  }
  return fail(args, verb, 'unknown two-lane run verb', 2);
}
