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
//
// Every run state transition settles through the canonical run APIs in
// `database/run-command.ts`: the run revision, its pinned inputs, one
// publication per attempt and the sealed terminal receipt are retained rows.
// The only file these verbs write is the served lane payload, which is
// rebuildable render data derived from the run's own pinned inputs.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError } from 'zod';

export {
  latencyProfileFor,
  ownershipSummaryFromComposed,
  type RoutineLatencyProfile,
  type RoutineLatencyTier,
  type TwolaneOwnershipSummary,
} from './twolaneRunMetadata.js';

import { type ExecutableIdentity, parseCitationId, slugifyBranch } from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';

import { CLAIM_LEDGER_SHARED_EXPLANATIONS } from './claimLedger.js';
import { deriveReviewOperationId } from './database/review-operation.js';
import {
  finalizeCanonicalRun,
  readCanonicalRun,
  readCanonicalRunFinalization,
  readCanonicalRunStatus,
  recordCanonicalLaneServed,
  forensicTerminal as runForensicTerminal,
  startCanonicalRun,
  submitCanonicalLane,
} from './database/run-command.js';
import { type TerminalRecord } from './database/terminal-record.js';
import {
  AccountCorpusCeilingError,
  type AccountProjection,
  ExcludePolicyError,
  type ForensicInput,
  ForensicTransportCeilingError,
  ReviewDiffTruncatedError,
  StubPolicyError,
} from './dossier.js';
import { writeReviewError, writeReviewOutput } from './reviewFiles.js';
import type { ReviewArgs } from './run.js';
import { SEMANTIC_ANCHOR_INPUT_FILE } from './semanticAnchors.js';
import { PartOwnershipInvariantError } from './storyOwnership.js';
import {
  STORY_REVIEW_MODEL_FILE,
  StoryReviewModelCatalogError,
  StoryReviewModelInvariantError,
  StoryReviewModelProjectionError,
  StoryReviewModelRangeError,
} from './storyReviewModel.js';
import {
  type DeclaredIsolation,
  executionProfileFieldSchema,
  ISOLATION_VALUES,
  TWOLANE_RUN_SCHEMA_VERSION,
  type TwolaneExecutionProfile,
  type TwolaneRunFile,
} from './twolaneRunFile.js';
import { latencyProfileFor } from './twolaneRunMetadata.js';
import {
  buildAccountPromptAliases,
  type Lane,
  partitionAccountEvaluatorRuns,
  ROUTINE_STORY_AUTHORING_SCHEMA_VERSION,
  SLICE_SCHEMA_VERSION,
  type SliceRunState,
} from './twolaneSlice.js';

// Run-file contract re-exports: the schema lives in the dependency-neutral
// twolaneRunFile.ts; existing importers keep this path.
export {
  type AccountSubmissionLineage,
  type DeclaredIsolation,
  type ExecutionProfileField,
  type RoutineNormalizationCode,
  type RoutineNormalizationSummaryCode,
  TWOLANE_RUN_SCHEMA_VERSION,
  type TwolaneAttemptRecord,
  type TwolaneExecutionProfile,
  type TwolaneRunFile,
} from './twolaneRunFile.js';

export const ROUTINE_ORDER_MESSAGE =
  'account context is served only after the forensic lane is terminal (accepted, or its submission attempts can no longer be repaired)';

const LANE_MD_FILE: Record<Lane, string> = {
  account: 'lane-account.md',
  forensic: 'lane-forensic.md',
};

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

const sha16 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/**
 * Where a served lane payload is written for the reviewer to read.
 *
 * Deliberately outside `.orcaops/reviews/`: the payload is rebuildable render
 * data derived from the run's own pinned inputs, never a publication. It is
 * rewritten on every serve and nothing reads it back as authority.
 */
const payloadPathFor = (root: string, branch: string, runId: string, lane: Lane): string =>
  path.join(
    root,
    '.orcaops',
    'tmp',
    'review-payloads',
    slugifyBranch(branch),
    runId,
    LANE_MD_FILE[lane]
  );

const emit = (value: unknown): void => {
  writeReviewOutput(`${JSON.stringify(value)}\n`);
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
  else writeReviewError(`review ${verb}: ${message}\n`);
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

/**
 * Every code `classifyFinalizeError` can emit. The public agreement test
 * iterates this list, so a code added to the classifier ships documented or
 * fails CI.
 */
export const TWOLANE_FINALIZE_ERROR_CODES = [
  'TWOLANE_EXECUTABLE_IDENTITY_DRIFT',
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
  const identityDrift =
    (error as { code?: string }).code === 'INVALID_INPUT' &&
    /executable identity pinned by this run/.test(message);
  if (identityDrift) return { code: 'TWOLANE_EXECUTABLE_IDENTITY_DRIFT', message };
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

/**
 * A malformed repo policy or a size-degradation ceiling is a refusal with its
 * own parseable envelope: an automated caller must be able to tell "the review
 * cannot be minted over this scope" from "the engine broke".
 */
function policyRefusal(args: ReviewArgs, verb: string, error: unknown): number | null {
  if (error instanceof StubPolicyError || error instanceof ExcludePolicyError) {
    if (args.json)
      emit({
        ok: false,
        error: {
          verb: `review ${verb}`,
          code: error.code,
          message: error.message,
          invalid_patterns: error.invalidPatterns,
        },
      });
    else writeReviewError(`review ${verb}: ${error.message}\n`);
    return 1;
  }
  if (
    error instanceof AccountCorpusCeilingError ||
    error instanceof ForensicTransportCeilingError ||
    error instanceof ReviewDiffTruncatedError
  ) {
    if (args.json)
      emit({
        ok: false,
        error: {
          verb: `review ${verb}`,
          code: error.code,
          message: error.message,
          ceiling_bytes: error.ceilingBytes,
          actual_bytes: error.actualBytes,
        },
      });
    else writeReviewError(`review ${verb}: ${error.message}\n`);
    return 1;
  }
  return null;
}

interface MintedRun {
  runId: string;
  reviewId: string;
  inputShas: Record<string, string>;
}

async function mintRun(
  args: ReviewArgs,
  root: string,
  branch: string,
  operationId: string
): Promise<{ ok: true; minted: MintedRun } | { ok: false; message: string }> {
  const executionProfile = parseExecutionProfile(args.executionProfileJson);
  if (!executionProfile.ok) return { ok: false, message: executionProfile.message };
  const started = await startCanonicalRun({
    branch,
    root,
    ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    profile: 'routine',
    createdAt: new Date().toISOString(),
    runtimeIdentity: args.runtimeIdentity ?? null,
    executionProfile: executionProfile.profile,
    operationId,
    secretAllow: [],
  });
  return {
    ok: true,
    minted: {
      runId: started.runId,
      reviewId: started.reviewId,
      inputShas: started.inputShas,
    },
  };
}

async function runStart(
  args: ReviewArgs,
  root: string,
  branch: string,
  operationId: string
): Promise<number> {
  const minted = await mintRun(args, root, branch, operationId);
  if (!minted.ok) return fail(args, 'start', minted.message, 2);
  if (args.json) {
    emit({
      ok: true,
      run_id: minted.minted.runId,
      review_id: minted.minted.reviewId,
      branch,
      mode: 'routine',
      schema_version: TWOLANE_RUN_SCHEMA_VERSION,
      lanes: ['forensic', 'account'],
      input_shas: minted.minted.inputShas,
    });
  } else {
    writeReviewOutput(`run ${minted.minted.runId} minted for review ${minted.minted.reviewId}\n`);
  }
  return 0;
}

function parseLane(value: string | undefined): Lane | null {
  return value === 'account' || value === 'forensic' ? value : null;
}

/**
 * Derive one lane's payload from the run's pinned inputs, write it where the
 * reviewer reads it, and record the lane's first-served timestamp.
 *
 * The account payload's facts block is the run's own scope, so it is derived
 * from the pinned forensic metrics rather than recomputed from the worktree.
 */
async function serveLaneEnvelope(
  root: string,
  branch: string,
  args: ReviewArgs,
  runId: string,
  lane: Lane,
  run: TwolaneRunFile,
  inputs: { projection: AccountProjection; forensicInput: ForensicInput },
  operationId: string
): Promise<{
  contract: Record<string, unknown>;
  payload_path: string;
  payload_sha: string;
  payload_bytes: number;
  served_at: string;
}> {
  const metrics = inputs.forensicInput.metrics;
  const markdown =
    lane === 'forensic'
      ? renderForensicRoutineMd(inputs.forensicInput)
      : renderAccountRoutineMd(inputs.projection, {
          runId,
          baseSha: inputs.forensicInput.baseSha ?? null,
          floorInputHash: inputs.projection.floor_input_hash,
          eligibleFiles: metrics.eligibleFiles,
          eligibleDiffBytes: metrics.eligibleDiffBytes,
          excludedFiles: metrics.excludedFiles,
          unreviewableFiles: metrics.unreviewableFiles,
          policyStubFiles:
            metrics.policyStubFiles ?? (inputs.forensicInput.policyStubs ?? []).length,
          policyStubRows:
            metrics.policyStubRows ??
            (inputs.forensicInput.policyStubs ?? []).reduce((n, x) => n + x.adds + x.dels, 0),
          latencyTier: latencyTierFor(metrics.eligibleDiffBytes),
        });
  const payloadPath = payloadPathFor(root, branch, runId, lane);
  // Written with plain fs on purpose: the payload is not review publication
  // state, so it must not go through the review write surface that constrains
  // writes to a prepared review directory.
  await mkdir(path.dirname(payloadPath), { recursive: true });
  await writeFile(payloadPath, markdown, 'utf8');
  const served = await recordCanonicalLaneServed({
    branch,
    root,
    ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    runId,
    lane,
    servedAt: new Date().toISOString(),
    operationId,
    secretAllow: [],
  });
  run.lane_inputs_served = served.run.lane_inputs_served;
  const bytes = Buffer.from(markdown, 'utf8');
  return {
    contract: LANE_CONTRACTS[lane],
    payload_path: path.relative(root, payloadPath),
    payload_sha: sha16(bytes),
    payload_bytes: bytes.length,
    served_at: served.servedAt,
  };
}

async function loadRun(args: ReviewArgs, root: string, branch: string, runId: string) {
  return readCanonicalRun({
    branch,
    root,
    ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    runId,
  });
}

async function runLaneInput(
  args: ReviewArgs,
  root: string,
  branch: string,
  operationId: string
): Promise<number> {
  const lane = parseLane(args.lane);
  if (lane === null) return fail(args, 'lane-input', '--lane must be `account` or `forensic`', 2);
  if (!args.runId) return fail(args, 'lane-input', '--run <run-id> is required', 2);
  const read = await loadRun(args, root, branch, args.runId);
  if (read === null) return fail(args, 'lane-input', `run ${args.runId} is not retained`, 1);
  if (lane === 'account' && !runForensicTerminal(read.run))
    return fail(args, 'lane-input', `TWOLANE_ROUTINE_ORDER: ${ROUTINE_ORDER_MESSAGE}`, 1);
  const served = await serveLaneEnvelope(
    root,
    branch,
    args,
    args.runId,
    lane,
    read.run,
    read.dossierInputs,
    operationId
  );
  const envelope = { ok: true, run_id: read.runId, lane, ...served };
  if (args.json) emit(envelope);
  else
    writeReviewOutput(
      `lane ${lane} input: ${envelope.payload_path} (${envelope.payload_bytes} bytes, sha ${envelope.payload_sha})\n`
    );
  return 0;
}

interface SubmitFlags {
  lane: Lane;
  runId: string;
  isolation: DeclaredIsolation;
  raw: string;
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
  return {
    ok: true,
    flags: {
      lane,
      runId: args.runId,
      isolation,
      raw: rawText,
      usageTokens,
      usageSource: args.usageSource ?? null,
      runtimeIdentity: args.runtimeIdentity ?? null,
    },
  };
}

type SubmitOutcome =
  | { status: 'notfound'; message: string }
  | { status: 'sealed' }
  | { status: 'identity-drift'; message: string }
  | { status: 'refused'; message: string }
  | {
      status: 'done';
      accepted: boolean;
      diagnostics: { code: string; message: string }[];
      run: TwolaneRunFile;
    };

/**
 * The submission is validated and published as one attempt. The routine
 * ordering refusal happens before the attempt is prepared, so an out-of-order
 * account submission consumes nothing.
 */
async function performSubmit(
  root: string,
  branch: string,
  args: ReviewArgs,
  flags: SubmitFlags,
  operationId: string
): Promise<SubmitOutcome> {
  const read = await loadRun(args, root, branch, flags.runId);
  if (read === null) return { status: 'notfound', message: `run ${flags.runId} is not retained` };
  if (read.run.finalized !== null) return { status: 'sealed' };
  const pinned = read.run.runtime_identity;
  if (
    pinned !== null &&
    pinned.runtimeFingerprintSha256 !== flags.runtimeIdentity?.runtimeFingerprintSha256
  )
    return {
      status: 'identity-drift',
      message:
        flags.runtimeIdentity === null
          ? 'the run pinned an executable identity, but this invocation supplied none'
          : `run executable fingerprint ${pinned.runtimeFingerprintSha256} does not match current fingerprint ${flags.runtimeIdentity.runtimeFingerprintSha256}`,
    };
  if (flags.lane === 'account' && !runForensicTerminal(read.run))
    return {
      status: 'done',
      accepted: false,
      diagnostics: [{ code: 'TWOLANE_ROUTINE_ORDER', message: ROUTINE_ORDER_MESSAGE }],
      run: read.run,
    };
  try {
    const submitted = await submitCanonicalLane({
      branch,
      root,
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      runId: flags.runId,
      lane: flags.lane,
      at: new Date().toISOString(),
      isolation: flags.isolation,
      usageTokens: flags.usageTokens,
      usageSource: flags.usageSource,
      runtimeIdentity: flags.runtimeIdentity,
      rawSubmission: flags.raw,
      operationId,
      secretAllow: [],
    });
    return {
      status: 'done',
      accepted: submitted.accepted,
      diagnostics: submitted.diagnostics,
      run: submitted.run,
    };
  } catch (error) {
    return { status: 'refused', message: (error as Error).message };
  }
}

function submitFailure(args: ReviewArgs, verb: string, outcome: SubmitOutcome): number | null {
  if (outcome.status === 'notfound') return fail(args, verb, outcome.message, 1);
  if (outcome.status === 'sealed')
    return fail(args, verb, `run ${args.runId!} is finalized; submissions are sealed`, 1);
  if (outcome.status === 'identity-drift')
    return fail(args, verb, `TWOLANE_EXECUTABLE_IDENTITY_DRIFT: ${outcome.message}`, 1);
  if (outcome.status === 'refused') return fail(args, verb, outcome.message, 1);
  return null;
}

async function runLaneSubmit(
  args: ReviewArgs,
  root: string,
  branch: string,
  operationId: string
): Promise<number> {
  const parsed = await parseSubmitFlags(args, 'lane-submit');
  if (!parsed.ok) return parsed.exit;
  const outcome = await performSubmit(root, branch, args, parsed.flags, operationId);
  const failed = submitFailure(args, 'lane-submit', outcome);
  if (failed !== null) return failed;
  const done = outcome as Extract<SubmitOutcome, { status: 'done' }>;
  const envelope = {
    ok: true,
    run_id: parsed.flags.runId,
    lane: parsed.flags.lane,
    accepted: done.accepted,
    diagnostics: done.diagnostics,
    state: stateEnvelope(done.run.slice_state),
  };
  if (args.json) emit(envelope);
  else
    writeReviewOutput(
      `lane ${parsed.flags.lane}: ${done.accepted ? 'accepted' : `rejected (${done.diagnostics.map((d) => d.code).join(', ') || 'no diagnostics'})`}\n`
    );
  return 0;
}

async function runRunShow(args: ReviewArgs, root: string, branch: string): Promise<number> {
  if (!args.runId) return fail(args, 'run-show', '--run <run-id> is required', 2);
  if (args.semanticInput && !args.json)
    return fail(args, 'run-show', '--semantic-input requires --json', 2);
  const read = await readCanonicalRunStatus({
    branch,
    root,
    ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    runId: args.runId,
  });
  if (read === null) return fail(args, 'run-show', `run ${args.runId} is not retained`, 1);
  const run = read.run;
  const finalization =
    args.semanticInput && run.finalized !== null
      ? await readCanonicalRunFinalization({
          branch,
          root,
          ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
          reviewId: read.reviewId,
          runId: read.runId,
          revisionId: read.revisionId,
          version: read.version,
        })
      : null;
  const envelope = {
    ok: true,
    run_id: run.run_id,
    review_id: read.reviewId,
    branch: run.branch,
    mode: run.mode,
    created_at: run.created_at,
    state: stateEnvelope(run.slice_state),
    forensic_terminal: forensicTerminal(run.slice_state),
    lane_inputs_served: run.lane_inputs_served,
    attempts: run.attempts,
    finalized: run.finalized,
    ...(args.semanticInput
      ? {
          semantic_anchor:
            finalization === null ? null : retainedSemanticAnchorResponse(finalization),
        }
      : {}),
  };
  if (args.json) emit(envelope);
  else
    writeReviewOutput(
      `run ${run.run_id}: account ${run.slice_state.lanes.account.outcome}, forensic ${run.slice_state.lanes.forensic.outcome}, repair credit account=${run.slice_state.lanes.account.repairCredit} forensic=${run.slice_state.lanes.forensic.repairCredit}, ${run.finalized === null ? 'open' : `finalized ${run.finalized.outcome}`}\n`
    );
  return 0;
}

const STORY_MEMBER_FILES = [
  'review.md',
  'brief.json',
  'composed-story-v2.json',
  STORY_REVIEW_MODEL_FILE,
] as const;

const finalizeFiles = (terminal: TerminalRecord): string[] => {
  const semantic = [
    terminal.semantic_anchor_input.receipt_file,
    terminal.semantic_anchor_input.payload_file,
  ].filter((file): file is NonNullable<typeof file> => file !== null);
  return [...(terminal.outputs === null ? [] : STORY_MEMBER_FILES), ...semantic];
};

const semanticAnchorResponse = (
  terminal: TerminalRecord,
  semanticPublicationId: string | null
): Record<string, unknown> => {
  const prepared = terminal.semantic_anchor_input;
  return {
    status: prepared.status,
    reason: prepared.reason,
    error_message: prepared.error_message,
    publication_id: semanticPublicationId,
    payload_file: prepared.payload_file,
    receipt_file: prepared.receipt_file,
    payload_hash: prepared.payload_sha256,
    payload_bytes: prepared.payload_bytes,
    estimated_input_tokens: prepared.estimated_input_tokens,
    estimated_minimum_output_tokens: prepared.estimated_minimum_output_tokens,
    eligible_citation_count: prepared.eligible_citation_count,
  };
};

const retainedSemanticAnchorResponse = (
  finalization: NonNullable<Awaited<ReturnType<typeof readCanonicalRunFinalization>>>
): Record<string, unknown> => {
  const semantic = finalization.publications.find((publication) => publication.kind === 'semantic');
  const payload = semantic?.members.find((member) => member.name === SEMANTIC_ANCHOR_INPUT_FILE);
  const ready = finalization.terminal.semantic_anchor_input.status === 'READY';
  return {
    ...semanticAnchorResponse(finalization.terminal, semantic?.publicationId ?? null),
    review_id: finalization.reviewId,
    run_id: finalization.runId,
    payload_content: ready ? (payload?.text ?? null) : null,
  };
};

async function performFinalize(
  args: ReviewArgs,
  root: string,
  branch: string,
  runId: string,
  runtimeIdentity: ExecutableIdentity | null,
  operationId: string
) {
  return finalizeCanonicalRun({
    branch,
    root,
    ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    runId,
    finalizedAt: new Date().toISOString(),
    runtimeIdentity,
    operationId,
    secretAllow: [],
  });
}

async function runFinalize(
  args: ReviewArgs,
  root: string,
  branch: string,
  operationId: string
): Promise<number> {
  if (!args.runId) return fail(args, 'finalize', '--run <run-id> is required', 2);
  let final: Awaited<ReturnType<typeof performFinalize>>;
  try {
    final = await performFinalize(
      args,
      root,
      branch,
      args.runId,
      args.runtimeIdentity ?? null,
      operationId
    );
  } catch (error) {
    const refusal = policyRefusal(args, 'finalize', error);
    if (refusal !== null) return refusal;
    const { code, message } = classifyFinalizeError(error);
    return fail(
      args,
      'finalize',
      `${code}: finalize failed after lane acceptance — ${message}. The run is not finalized; finalize is retryable once the engine state is fixed.`,
      1
    );
  }
  if (final.status === 'already-sealed') {
    if (final.outcome === 'FAILED')
      return fail(
        args,
        'finalize',
        `run ${args.runId} is already finalized FAILED (${final.terminal.finalized_at}); no Story output exists to publish`,
        1
      );
    if (args.json)
      emit({
        ok: true,
        status: 'already-finalized',
        run_id: args.runId,
        outcome: final.outcome,
        finalized_at: final.terminal.finalized_at,
        current_story: {
          publication_id: final.storyPublicationId,
          generation: final.storyGeneration,
        },
      });
    else
      writeReviewOutput(
        `run ${args.runId} was already finalized (${final.outcome} at ${final.terminal.finalized_at}); its retained Story is selected\n`
      );
    return 0;
  }
  if (args.json) {
    emit({
      ok: true,
      run_id: args.runId,
      review_id: final.reviewId,
      outcome: final.outcome,
      story_publication_id: final.storyPublicationId,
      files: finalizeFiles(final.terminal),
      ownership_summary: final.terminal.ownership_summary,
      semantic_anchor: semanticAnchorResponse(final.terminal, final.semanticPublicationId),
      current_story: {
        publication_id: final.storyPublicationId,
        generation: final.storyGeneration,
      },
      run_record: final.terminal,
    });
  } else {
    writeReviewOutput(
      `run ${args.runId} finalized: ${final.outcome}${final.terminal.outputs === null ? ' (no lane accepted)' : ''}\n`
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Composite routine verbs: deterministic cycle-time
// consolidation — the same machinery, fewer host turns, still model-free.
// ---------------------------------------------------------------------------

/**
 * `routine-start` (the floor is published by the dispatcher in run.ts before
 * this): mint the run and serve the forensic input in one envelope.
 */
async function runRoutineStart(
  args: ReviewArgs,
  root: string,
  branch: string,
  operationId: string
): Promise<number> {
  const minted = await mintRun(args, root, branch, operationId);
  if (!minted.ok) return fail(args, 'routine-start', minted.message, 2);
  const read = await loadRun(args, root, branch, minted.minted.runId);
  if (read === null) return fail(args, 'routine-start', 'the minted run is not retained', 1);
  const served = await serveLaneEnvelope(
    root,
    branch,
    args,
    minted.minted.runId,
    'forensic',
    read.run,
    read.dossierInputs,
    deriveReviewOperationId(operationId, 'review.run.inputs-served')
  );
  const envelope = {
    ok: true,
    run_id: minted.minted.runId,
    review_id: minted.minted.reviewId,
    branch,
    mode: 'routine',
    input_shas: minted.minted.inputShas,
    lane: 'forensic',
    ...served,
  };
  if (args.json) emit(envelope);
  else
    writeReviewOutput(
      `run ${minted.minted.runId}: forensic input at ${envelope.payload_path} (${envelope.payload_bytes} bytes)\n`
    );
  return 0;
}

/**
 * `routine-submit`: validate one lane submission; on forensic acceptance the
 * response carries the account input; on account acceptance the run is
 * finalized in the same call and the response carries the outcome + record.
 * A rejected submission returns diagnostics — the same command accepts the
 * repaired payload.
 */
async function runRoutineSubmit(
  args: ReviewArgs,
  root: string,
  branch: string,
  operationId: string
): Promise<number> {
  const parsed = await parseSubmitFlags(args, 'routine-submit');
  if (!parsed.ok) return parsed.exit;
  const flags = parsed.flags;
  const outcome = await performSubmit(root, branch, args, flags, operationId);
  const failed = submitFailure(args, 'routine-submit', outcome);
  if (failed !== null) return failed;
  const done = outcome as Extract<SubmitOutcome, { status: 'done' }>;
  const state = done.run.slice_state;
  const envelope: Record<string, unknown> = {
    ok: true,
    run_id: flags.runId,
    lane: flags.lane,
    accepted: done.accepted,
    diagnostics: done.diagnostics,
    state: stateEnvelope(state),
  };
  // Chaining is on TERMINALITY, not acceptance: a lane that
  // exhausts its repair still advances the program — the reviewer is never
  // stranded without a next step.
  const accountTerminal =
    state.lanes.account.accepted || state.lanes.account.outcome === 'TERMINAL_REJECTED';
  if (flags.lane === 'forensic' && forensicTerminal(state)) {
    const read = await loadRun(args, root, branch, flags.runId);
    if (read !== null)
      envelope.account = await serveLaneEnvelope(
        root,
        branch,
        args,
        flags.runId,
        'account',
        read.run,
        read.dossierInputs,
        deriveReviewOperationId(operationId, 'review.run.inputs-served')
      );
  }
  if (flags.lane === 'account' && accountTerminal) {
    // The submission is already accepted and retained; a composition failure
    // past this point is an ENGINE defect, never a payload problem. It must
    // not surface as a submit rejection (the reviewer would resubmit and burn
    // SLICE_SUBMIT_AFTER_ACCEPT) — it reports as a parseable finalize-stage
    // failure with the acceptance state explicit, and `review finalize` stays
    // retryable.
    try {
      const final = await performFinalize(
        args,
        root,
        branch,
        flags.runId,
        flags.runtimeIdentity,
        deriveReviewOperationId(operationId, 'review.run.finalize')
      );
      envelope.outcome = final.outcome;
      envelope.review_id = final.reviewId;
      envelope.story_publication_id = final.storyPublicationId;
      envelope.files = finalizeFiles(final.terminal);
      envelope.ownership_summary = final.terminal.ownership_summary;
      envelope.semantic_anchor = semanticAnchorResponse(
        final.terminal,
        final.semanticPublicationId
      );
      envelope.current_story = {
        publication_id: final.storyPublicationId,
        generation: final.storyGeneration,
      };
      envelope.run_record = final.terminal;
    } catch (error) {
      envelope.finalize_error = {
        code: classifyFinalizeError(error).code,
        stage: 'finalize',
        lane_accepted: done.accepted,
        run_finalized: false,
        message: (error as Error).message,
        retry: `orcaops review finalize --branch ${branch} --run ${flags.runId}`,
      };
    }
  }
  if (args.json) emit(envelope);
  else
    writeReviewOutput(
      `lane ${flags.lane}: ${done.accepted ? 'accepted' : `rejected (${done.diagnostics.map((d) => d.code).join(', ') || 'no diagnostics'})`}${envelope.outcome !== undefined ? ` — finalized ${String(envelope.outcome)}` : ''}\n`
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

export async function runTwolaneRun(
  args: ReviewArgs,
  root: string,
  operationId: string = uuidv7()
): Promise<number> {
  const verb = args.sub ?? '';
  if (!args.branch) return fail(args, verb, '--branch is required', 2);
  try {
    if (verb === 'start') return await runStart(args, root, args.branch, operationId);
    if (verb === 'lane-input') return await runLaneInput(args, root, args.branch, operationId);
    if (verb === 'lane-submit') return await runLaneSubmit(args, root, args.branch, operationId);
    if (verb === 'run-show') return await runRunShow(args, root, args.branch);
    if (verb === 'finalize') return await runFinalize(args, root, args.branch, operationId);
    if (verb === 'routine-start')
      return await runRoutineStart(args, root, args.branch, operationId);
    if (verb === 'routine-submit')
      return await runRoutineSubmit(args, root, args.branch, operationId);
  } catch (error) {
    const refusal = policyRefusal(args, verb, error);
    if (refusal !== null) return refusal;
    return fail(args, verb, (error as Error).message, 1);
  }
  return fail(args, verb, 'unknown two-lane run verb', 2);
}
