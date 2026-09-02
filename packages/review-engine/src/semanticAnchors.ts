// Semantic anchoring is a derived, non-adjudicating association layer over a
// completed routine review. This module owns the deterministic PREPARED INPUT
// only: the model-facing association lifecycle lives separately so preparing an
// input can never change Story topology, checkpoint ownership, findings,
// uncertainty state, or any engine-adjudicated result.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { CITATION_KIND } from '@orcaops/review-core';

import type { AccountProjection, DossierDecision, ForensicInput, PolicyStub } from './dossier.js';
import type { CoverageInput } from './storyOwnership.js';
import type { StoryReviewModel } from './storyReviewModel.js';

export const SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION = 4;
export const SEMANTIC_ANCHOR_INPUT_FILE = 'semantic-anchor-input-v4.md';
export const SEMANTIC_ANCHOR_RECEIPT_FILE = 'semantic-anchor-input-v4.json';
export const SEMANTIC_ANCHOR_PROFILE = 'semantic-anchor-profile-v1';

/**
 * One registered context contract, deliberately independent of a provider SDK.
 * The estimator is conservative for mixed prose/code. Both limits are hard:
 * callers must refuse the complete payload rather than select or truncate it.
 */
export const SEMANTIC_ANCHOR_PROFILE_V1 = {
  profile: SEMANTIC_ANCHOR_PROFILE,
  profile_source: 'ENGINE_REGISTERED' as const,
  context_window_tokens: 1_000_000,
  hard_transport_bytes: 2_000_000,
  estimated_token_divisor_bytes: 3,
  instruction_reserve_tokens: 16_000,
  maximum_output_tokens: 32_000,
  context_reserve_percent: 10,
  maximum_submission_bytes: 128_000,
};

export const ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS = [
  CITATION_KIND.PLAN_DECISION,
  CITATION_KIND.PLAN_ALTERNATIVE,
  CITATION_KIND.CHECKPOINT_DECISION,
  CITATION_KIND.CHECKPOINT_ALTERNATIVE,
  CITATION_KIND.CHECKPOINT_UNCERTAINTY,
] as const;
export type EligibleSemanticAnchorCitationKind =
  (typeof ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS)[number];

export interface SemanticAnchorCitation {
  /** Prompt-local, deterministic alias. Never used as durable identity. */
  alias: string;
  id: string;
  kind: EligibleSemanticAnchorCitationKind;
  text: string;
  parent?: string;
  checkpoint_ref?: string;
}

export type SemanticAnchorInputStatus = 'READY' | 'TOO_LARGE' | 'NOT_ELIGIBLE' | 'UNAVAILABLE';

export const SEMANTIC_ANCHOR_INPUT_REASONS = [
  'CORE_STORY_ABSENT',
  'NO_ELIGIBLE_CITATIONS',
  'NO_CHANGED_ROWS',
  'ACCOUNT_PROJECTION_UNAVAILABLE',
  'ACCOUNT_LINEAGE_UNAVAILABLE',
  'COVERAGE_UNAVAILABLE',
  'PINNED_DIFF_UNAVAILABLE',
  'FORENSIC_INPUT_UNAVAILABLE',
  'HARD_TRANSPORT_BYTES_EXCEEDED',
  'ESTIMATED_TOKEN_BUDGET_EXCEEDED',
  'MINIMUM_OUTPUT_BUDGET_EXCEEDED',
  'PREPARATION_FAILED',
  'PREPARED_INPUT_WRITE_FAILED',
] as const;
export type SemanticAnchorInputReason = (typeof SEMANTIC_ANCHOR_INPUT_REASONS)[number];

export interface SemanticAnchorExclusionEntry {
  path: string;
  bucket: 'CAPTURE_INTERNAL' | 'BINARY_UNREVIEWABLE' | 'POLICY_STUB';
  reason: 'capture-internal' | 'binary' | 'review.stub_paths' | 'capture.exclude';
  adds: number | null;
  deletes: number | null;
  bytes: number | null;
}

export interface CompactSemanticAnchorStory {
  overview: StoryReviewModel['overview'];
  acts: Pick<StoryReviewModel['acts'][number], 'id' | 'title' | 'interpretation' | 'partIds'>[];
  parts: Pick<
    StoryReviewModel['parts'][number],
    'id' | 'title' | 'act' | 'checkpointRefs' | 'interpretation' | 'citations'
  >[];
  questions: Pick<StoryReviewModel['questions'][number], 'id' | 'lane' | 'text'>[];
}

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

const budgetReceiptSchema = z.strictObject({
  context_window_tokens: z.number().int().positive(),
  hard_transport_bytes: z.number().int().positive(),
  estimated_token_divisor_bytes: z.number().int().positive(),
  instruction_reserve_tokens: z.number().int().nonnegative(),
  maximum_output_tokens: z.number().int().nonnegative(),
  context_reserve_percent: z.number().int().min(0).max(99),
  maximum_submission_bytes: z.number().int().positive(),
});

export const semanticAnchorInputReceiptSchema = z.strictObject({
  schema_version: z.literal(SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION),
  status: z.enum(['READY', 'TOO_LARGE', 'NOT_ELIGIBLE', 'UNAVAILABLE']),
  reason: z.enum(SEMANTIC_ANCHOR_INPUT_REASONS).nullable(),
  error_message: z.string().min(1).nullable(),
  run_id: z.string().min(1),
  floor_input_hash: z.string().min(1).nullable(),
  profile: z.literal(SEMANTIC_ANCHOR_PROFILE),
  profile_source: z.literal('ENGINE_REGISTERED'),
  budget: budgetReceiptSchema,
  source_hashes: z.strictObject({
    story_review_model_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    account_projection_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    coverage_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    diff_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    accepted_account_envelope_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    compiled_account_payload_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  }),
  derivation_hashes: z.strictObject({
    forensic_input_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    policy_eligible_diff_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    compact_story_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    exclusion_inventory_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    change_block_catalog_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  }),
  target_scope: z
    .strictObject({
      kind: z.literal('POLICY_ELIGIBLE_DIFF'),
      eligible_files: z.number().int().nonnegative(),
      eligible_diff_bytes: z.number().int().nonnegative(),
      excluded_files: z.number().int().nonnegative(),
      capture_internal_files: z.number().int().nonnegative(),
      binary_unreviewable_files: z.number().int().nonnegative(),
      policy_stub_files: z.number().int().nonnegative(),
      known_excluded_adds: z.number().int().nonnegative(),
      known_excluded_deletes: z.number().int().nonnegative(),
      known_excluded_bytes: z.number().int().nonnegative(),
      exclusion_inventory_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .nullable(),
  payload_file: z.literal(SEMANTIC_ANCHOR_INPUT_FILE).nullable(),
  payload_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  payload_bytes: z.number().int().nonnegative().nullable(),
  estimated_input_tokens: z.number().int().nonnegative().nullable(),
  estimated_minimum_output_tokens: z.number().int().nonnegative().nullable(),
  usable_input_tokens: z.number().int().nonnegative(),
  eligible_citation_count: z.number().int().nonnegative(),
  hunk_count: z.number().int().nonnegative(),
  change_block_count: z.number().int().nonnegative(),
  changed_row_count: z.number().int().nonnegative(),
});
export type SemanticAnchorInputReceipt = z.infer<typeof semanticAnchorInputReceiptSchema>;

export class UnsupportedSemanticAnchorInputVersionError extends Error {
  readonly code = 'UNSUPPORTED_SEMANTIC_ANCHOR_INPUT_VERSION';

  constructor(readonly actualVersion: number) {
    super(
      `semantic anchor prepared input schema ${actualVersion} is unsupported; completed historical inputs remain immutable evidence and are not backfilled`
    );
    this.name = 'UnsupportedSemanticAnchorInputVersionError';
  }
}

/** Reject historical prepared-input contracts before v4 shape validation. */
export function parseSemanticAnchorInputReceipt(raw: unknown): SemanticAnchorInputReceipt {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as { schema_version?: unknown }).schema_version === 'number' &&
    (raw as { schema_version: number }).schema_version !== SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION
  )
    throw new UnsupportedSemanticAnchorInputVersionError(
      (raw as { schema_version: number }).schema_version
    );
  return semanticAnchorInputReceiptSchema.parse(raw);
}

export interface SemanticAnchorPreparation {
  receipt: SemanticAnchorInputReceipt;
  /** Present only when status is READY. TOO_LARGE never writes tempting partial input. */
  payload: string | null;
  /** Deterministic prompt-local item aliases and their durable capture identities. */
  items: SemanticAnchorCitation[];
  /** Complete policy-eligible block catalog used to resolve model-authored aliases. */
  blockCatalog: SemanticAnchorChangeBlockCatalog | null;
}

export interface SemanticAnchorPreparationInput {
  runId: string;
  storyModel: StoryReviewModel | null;
  storyModelBytes: string | null;
  accountProjection: AccountProjection | null;
  accountProjectionBytes: string | null;
  coverage: CoverageInput | null;
  coverageBytes: string | null;
  /** Full pinned diff retained only as immutable run lineage. */
  pinnedDiffText: string | null;
  /** Immutable forensic input whose `diff` is the policy-eligible target space. */
  forensicInput: ForensicInput | null;
  forensicInputBytes: string | null;
  /** Canonical accepted-account lineage recorded by the finalized run. */
  accountLineage: {
    acceptedEnvelopeSha256: string;
    compiledPayloadSha256: string;
  } | null;
  profile?: typeof SEMANTIC_ANCHOR_PROFILE_V1;
}

function usableInputTokens(profile: typeof SEMANTIC_ANCHOR_PROFILE_V1): number {
  const contextReserve = Math.ceil(
    (profile.context_window_tokens * profile.context_reserve_percent) / 100
  );
  return Math.max(
    0,
    profile.context_window_tokens -
      contextReserve -
      profile.instruction_reserve_tokens -
      profile.maximum_output_tokens
  );
}

function sourceHashes(
  input: SemanticAnchorPreparationInput
): SemanticAnchorInputReceipt['source_hashes'] {
  return {
    story_review_model_sha256:
      input.storyModelBytes === null ? null : sha256(input.storyModelBytes),
    account_projection_sha256:
      input.accountProjectionBytes === null ? null : sha256(input.accountProjectionBytes),
    coverage_sha256: input.coverageBytes === null ? null : sha256(input.coverageBytes),
    diff_sha256: input.pinnedDiffText === null ? null : sha256(input.pinnedDiffText),
    accepted_account_envelope_sha256: input.accountLineage?.acceptedEnvelopeSha256 ?? null,
    compiled_account_payload_sha256: input.accountLineage?.compiledPayloadSha256 ?? null,
  };
}

const codePointCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** The exact Story subset needed to understand citation context, without code segments. */
export function compactSemanticAnchorStory(model: StoryReviewModel): CompactSemanticAnchorStory {
  return {
    overview:
      model.overview === null
        ? null
        : { text: model.overview.text, citations: [...model.overview.citations] },
    acts: model.acts.map(({ id, title, interpretation, partIds }) => ({
      id,
      title,
      interpretation,
      partIds,
    })),
    parts: model.parts.map(({ id, title, act, checkpointRefs, interpretation, citations }) => ({
      id,
      title,
      act,
      checkpointRefs,
      interpretation,
      citations,
    })),
    questions: model.questions.map(({ id, lane, text }) => ({ id, lane, text })),
  };
}

const policyStubEntry = (stub: PolicyStub): SemanticAnchorExclusionEntry => ({
  path: stub.path,
  bucket: 'POLICY_STUB',
  reason: stub.reason,
  adds: stub.adds,
  deletes: stub.dels,
  bytes: stub.bytes,
});

/** Deterministic global disclosure of files outside the semantic target space. */
export function semanticAnchorExclusionInventory(
  forensicInput: ForensicInput
): SemanticAnchorExclusionEntry[] {
  return [
    ...(forensicInput.excludedPaths ?? []).map(
      (path): SemanticAnchorExclusionEntry => ({
        path,
        bucket: 'CAPTURE_INTERNAL',
        reason: 'capture-internal',
        adds: null,
        deletes: null,
        bytes: null,
      })
    ),
    ...(forensicInput.unreviewablePaths ?? []).map(
      (path): SemanticAnchorExclusionEntry => ({
        path,
        bucket: 'BINARY_UNREVIEWABLE',
        reason: 'binary',
        adds: null,
        deletes: null,
        bytes: null,
      })
    ),
    ...(forensicInput.policyStubs ?? []).map(policyStubEntry),
  ].sort((left, right) => codePointCompare(left.path, right.path));
}

function targetScope(
  forensicInput: ForensicInput,
  inventory: readonly SemanticAnchorExclusionEntry[]
): NonNullable<SemanticAnchorInputReceipt['target_scope']> {
  const inventorySha = sha256(JSON.stringify(inventory));
  return {
    kind: 'POLICY_ELIGIBLE_DIFF',
    eligible_files: forensicInput.metrics.eligibleFiles,
    eligible_diff_bytes: Buffer.byteLength(forensicInput.diff, 'utf8'),
    excluded_files: inventory.length,
    capture_internal_files: inventory.filter((item) => item.bucket === 'CAPTURE_INTERNAL').length,
    binary_unreviewable_files: inventory.filter((item) => item.bucket === 'BINARY_UNREVIEWABLE')
      .length,
    policy_stub_files: inventory.filter((item) => item.bucket === 'POLICY_STUB').length,
    known_excluded_adds: inventory.reduce((sum, item) => sum + (item.adds ?? 0), 0),
    known_excluded_deletes: inventory.reduce((sum, item) => sum + (item.deletes ?? 0), 0),
    known_excluded_bytes: inventory.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    exclusion_inventory_sha256: inventorySha,
  };
}

function derivedInputs(input: SemanticAnchorPreparationInput): {
  compactStory: CompactSemanticAnchorStory | null;
  compactStoryBytes: string | null;
  inventory: SemanticAnchorExclusionEntry[] | null;
  scope: SemanticAnchorInputReceipt['target_scope'];
  hashes: SemanticAnchorInputReceipt['derivation_hashes'];
} {
  const compactStory =
    input.storyModel === null ? null : compactSemanticAnchorStory(input.storyModel);
  const compactStoryBytes = compactStory === null ? null : JSON.stringify(compactStory);
  const inventory =
    input.forensicInput === null ? null : semanticAnchorExclusionInventory(input.forensicInput);
  const scope =
    input.forensicInput === null || inventory === null
      ? null
      : targetScope(input.forensicInput, inventory);
  return {
    compactStory,
    compactStoryBytes,
    inventory,
    scope,
    hashes: {
      forensic_input_sha256:
        input.forensicInputBytes === null ? null : sha256(input.forensicInputBytes),
      policy_eligible_diff_sha256:
        input.forensicInput === null ? null : sha256(input.forensicInput.diff),
      compact_story_sha256: compactStoryBytes === null ? null : sha256(compactStoryBytes),
      exclusion_inventory_sha256: scope?.exclusion_inventory_sha256 ?? null,
      change_block_catalog_sha256: null,
    },
  };
}

const budgetReceipt = (profile: typeof SEMANTIC_ANCHOR_PROFILE_V1) => ({
  context_window_tokens: profile.context_window_tokens,
  hard_transport_bytes: profile.hard_transport_bytes,
  estimated_token_divisor_bytes: profile.estimated_token_divisor_bytes,
  instruction_reserve_tokens: profile.instruction_reserve_tokens,
  maximum_output_tokens: profile.maximum_output_tokens,
  context_reserve_percent: profile.context_reserve_percent,
  maximum_submission_bytes: profile.maximum_submission_bytes,
});

function emptyReceipt(
  input: SemanticAnchorPreparationInput,
  status: Exclude<SemanticAnchorInputStatus, 'READY' | 'TOO_LARGE'>,
  reason: SemanticAnchorInputReason,
  errorMessage: string | null = null,
  counts: { eligible?: number; hunks?: number; blocks?: number; rows?: number } = {}
): SemanticAnchorPreparation {
  const profile = input.profile ?? SEMANTIC_ANCHOR_PROFILE_V1;
  const derived = derivedInputs(input);
  return {
    receipt: semanticAnchorInputReceiptSchema.parse({
      schema_version: SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION,
      status,
      reason,
      error_message: errorMessage,
      run_id: input.runId,
      floor_input_hash: input.accountProjection?.floor_input_hash ?? null,
      profile: profile.profile,
      profile_source: profile.profile_source,
      budget: budgetReceipt(profile),
      source_hashes: sourceHashes(input),
      derivation_hashes: derived.hashes,
      target_scope: derived.scope,
      payload_file: null,
      payload_sha256: null,
      payload_bytes: null,
      estimated_input_tokens: null,
      estimated_minimum_output_tokens: null,
      usable_input_tokens: usableInputTokens(profile),
      eligible_citation_count: counts.eligible ?? 0,
      hunk_count: counts.hunks ?? 0,
      change_block_count: counts.blocks ?? 0,
      changed_row_count: counts.rows ?? 0,
    }),
    payload: null,
    items: [],
    blockCatalog: null,
  };
}

/** A safe receipt for an unexpected preparation/read/write failure. */
export function unavailableSemanticAnchorPreparation(
  runId: string,
  reason: Extract<SemanticAnchorInputReason, 'PREPARATION_FAILED' | 'PREPARED_INPUT_WRITE_FAILED'>,
  errorMessage: string | null,
  input: Partial<Omit<SemanticAnchorPreparationInput, 'runId'>> = {}
): SemanticAnchorPreparation {
  return emptyReceipt(
    {
      runId,
      storyModel: input.storyModel ?? null,
      storyModelBytes: input.storyModelBytes ?? null,
      accountProjection: input.accountProjection ?? null,
      accountProjectionBytes: input.accountProjectionBytes ?? null,
      coverage: input.coverage ?? null,
      coverageBytes: input.coverageBytes ?? null,
      pinnedDiffText: input.pinnedDiffText ?? null,
      forensicInput: input.forensicInput ?? null,
      forensicInputBytes: input.forensicInputBytes ?? null,
      accountLineage: input.accountLineage ?? null,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    },
    'UNAVAILABLE',
    reason,
    errorMessage
  );
}

function pushDecision(
  out: Omit<SemanticAnchorCitation, 'alias'>[],
  decision: DossierDecision,
  decisionKind: typeof CITATION_KIND.PLAN_DECISION | typeof CITATION_KIND.CHECKPOINT_DECISION,
  alternativeKind:
    | typeof CITATION_KIND.PLAN_ALTERNATIVE
    | typeof CITATION_KIND.CHECKPOINT_ALTERNATIVE,
  checkpointRef?: string
): void {
  out.push({
    id: decision.citationId,
    kind: decisionKind,
    text: decision.text,
    ...(checkpointRef !== undefined ? { checkpoint_ref: checkpointRef } : {}),
  });
  for (const alternative of decision.alternatives) {
    out.push({
      id: alternative.citationId,
      kind: alternativeKind,
      text: alternative.text,
      parent: decision.citationId,
      ...(checkpointRef !== undefined ? { checkpoint_ref: checkpointRef } : {}),
    });
  }
}

/** Flatten the mechanically pinned v1 citation set, preserving complete prose. */
export function collectEligibleSemanticAnchorCitations(
  projection: AccountProjection
): SemanticAnchorCitation[] {
  const out: Omit<SemanticAnchorCitation, 'alias'>[] = [];
  for (const decision of projection.accountCore.planDecisions)
    pushDecision(out, decision, CITATION_KIND.PLAN_DECISION, CITATION_KIND.PLAN_ALTERNATIVE);
  for (const checkpoint of projection.accountCore.checkpoints) {
    const checkpointRef = `${checkpoint.artifact}:cp${checkpoint.cp}`;
    for (const decision of checkpoint.decisions)
      pushDecision(
        out,
        decision,
        CITATION_KIND.CHECKPOINT_DECISION,
        CITATION_KIND.CHECKPOINT_ALTERNATIVE,
        checkpointRef
      );
    for (const uncertainty of checkpoint.uncertainty) {
      out.push({
        id: uncertainty.citationId,
        kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
        text: uncertainty.text,
        checkpoint_ref: checkpointRef,
      });
    }
  }
  return out.map((citation, index) => ({ ...citation, alias: `i${index + 1}` }));
}

/**
 * Cross-contract guard for the asynchronously-created anchor generation. Story
 * v4 is installed first; an opt-in anchor pass may arrive later, but every item
 * it assesses must still resolve through that run's self-sufficient catalog.
 */
export function semanticAnchorStoryCatalogIssue(
  story: StoryReviewModel,
  items: readonly Pick<SemanticAnchorCitation, 'id' | 'kind'>[]
): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return `semantic anchor item ${item.id} appears more than once`;
    seen.add(item.id);
  }
  for (const item of items) {
    const citation = story.citations[item.id];
    if (citation === undefined)
      return `semantic anchor item ${item.id} is absent from the Story v4 citation catalog`;
    if (citation.kind !== item.kind)
      return `semantic anchor item ${item.id} kind ${item.kind} disagrees with Story v4 kind ${citation.kind}`;
  }
  return null;
}

export type SemanticAnchorFileChange = 'ADDITION' | 'DELETION' | 'MODIFICATION' | 'RENAME';
export type SemanticAnchorChangeBlockKind = 'ADDITION' | 'DELETION' | 'REPLACEMENT';

export interface SemanticAnchorCanonicalRange {
  start: number;
  end: number;
}

export interface SemanticAnchorChangeLine {
  /** Prompt-local row coordinate, block-local on each side (A1/D1...). */
  ref: string;
  side: 'add' | 'delete';
  oldLine: number | null;
  newLine: number | null;
  body: string;
  /** Durable key material only. The prepared prompt never renders this hash. */
  lineHash: string;
  /** True when git's no-newline marker immediately follows this changed line. */
  noNewline: boolean;
}

export interface SemanticAnchorChangeBlock {
  /** Prompt-local alias nested beneath its hunk, e.g. `h2.b1`. */
  alias: string;
  /** Content-derived identity; independent of every prompt alias and display label. */
  blockKey: string;
  kind: SemanticAnchorChangeBlockKind;
  oldRange: SemanticAnchorCanonicalRange | null;
  newRange: SemanticAnchorCanonicalRange | null;
  lines: SemanticAnchorChangeLine[];
}

export interface SemanticAnchorChangeHunk {
  /** Prompt-local alias only, e.g. `h2`. */
  alias: string;
  hunkKey: string;
  oldFile: string | null;
  newFile: string | null;
  displayPath: string;
  fileChange: SemanticAnchorFileChange;
  header: string;
  blocks: SemanticAnchorChangeBlock[];
}

export interface SemanticAnchorChangeBlockCatalog {
  /** Complete policy-eligible diff with additive alias markers; no source line is removed. */
  text: string;
  hunkCount: number;
  blockCount: number;
  changedRowCount: number;
  hunks: SemanticAnchorChangeHunk[];
  /** Prompt alias -> durable block key. */
  blockAliases: Record<string, string>;
  /** Prompt alias -> durable hunk identity. */
  hunkAliases: Record<string, string>;
}

export interface SemanticAnchorChangeBlockKeyInput {
  oldFile: string | null;
  newFile: string | null;
  hunkKey: string;
  oldRange: SemanticAnchorCanonicalRange | null;
  newRange: SemanticAnchorCanonicalRange | null;
  changedLines: readonly Pick<
    SemanticAnchorChangeLine,
    'side' | 'oldLine' | 'newLine' | 'lineHash'
  >[];
}

const canonicalRangeKey = (range: SemanticAnchorCanonicalRange | null): string =>
  range === null ? '-' : `${range.start}:${range.end}`;

/**
 * Durable block identity. Only canonical old/new file identities, the durable
 * hunk identity, canonical side ranges, and changed-line hashes participate.
 * Prompt aliases, display paths, prose, and input iteration order do not.
 */
export function semanticAnchorChangeBlockKey(input: SemanticAnchorChangeBlockKeyInput): string {
  const changedLines = input.changedLines
    .slice()
    .sort((left, right) => {
      const side = (left.side === 'delete' ? 0 : 1) - (right.side === 'delete' ? 0 : 1);
      if (side !== 0) return side;
      const leftLine = left.side === 'delete' ? left.oldLine : left.newLine;
      const rightLine = right.side === 'delete' ? right.oldLine : right.newLine;
      return (leftLine ?? 0) - (rightLine ?? 0) || codePointCompare(left.lineHash, right.lineHash);
    })
    .map((line) => `${line.side}:${line.oldLine ?? '-'}:${line.newLine ?? '-'}:${line.lineHash}`);
  return `block_${sha256(
    JSON.stringify([
      'semantic-anchor-change-block-v1',
      input.oldFile,
      input.newFile,
      input.hunkKey,
      canonicalRangeKey(input.oldRange),
      canonicalRangeKey(input.newRange),
      ...changedLines,
    ])
  )}`;
}

type MutableChangeBlock = Omit<SemanticAnchorChangeBlock, 'alias' | 'blockKey'> & {
  sourceIndex: number;
  lineSourceIndexes: number[];
  addCount: number;
  deleteCount: number;
};
type MutableChangeHunk = Omit<SemanticAnchorChangeHunk, 'alias' | 'blocks'> & {
  sourceIndex: number;
  blocks: MutableChangeBlock[];
};

const GIT_PATH_ESCAPES: Record<string, string> = {
  t: '\t',
  n: '\n',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '"': '"',
  '\\': '\\',
};

function decodeGitPath(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path;
  const inner = path.slice(1, -1);
  let out = '';
  let octal: number[] = [];
  const flush = () => {
    if (octal.length > 0) {
      out += Buffer.from(octal).toString('utf8');
      octal = [];
    }
  };
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (char !== '\\') {
      flush();
      out += char;
      continue;
    }
    const next = inner[index + 1] ?? '';
    if (next >= '0' && next <= '7') {
      let digits = '';
      let cursor = index + 1;
      while (
        cursor < inner.length &&
        digits.length < 3 &&
        inner[cursor]! >= '0' &&
        inner[cursor]! <= '7'
      ) {
        digits += inner[cursor];
        cursor += 1;
      }
      octal.push(Number.parseInt(digits, 8));
      index = cursor - 1;
    } else {
      flush();
      out += GIT_PATH_ESCAPES[next] ?? next;
      index += 1;
    }
  }
  flush();
  return out;
}

function diffPath(raw: string): string | null {
  const decoded = decodeGitPath(raw.trim());
  if (decoded === '/dev/null') return null;
  return decoded.startsWith('a/') || decoded.startsWith('b/') ? decoded.slice(2) : decoded;
}

function gitHeaderPaths(raw: string): { oldFile: string | null; newFile: string | null } {
  const quoted = /^diff --git ("a\/(?:[^"\\]|\\.)+") ("b\/(?:[^"\\]|\\.)+")$/.exec(raw);
  if (quoted !== null) return { oldFile: diffPath(quoted[1]!), newFile: diffPath(quoted[2]!) };
  const plain = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
  return plain === null
    ? { oldFile: null, newFile: null }
    : { oldFile: plain[1] ?? null, newFile: plain[2] ?? null };
}

const blockRange = (
  lines: readonly SemanticAnchorChangeLine[],
  side: 'add' | 'delete'
): SemanticAnchorCanonicalRange | null => {
  const positions = lines
    .filter((line) => line.side === side)
    .map((line) => (side === 'add' ? line.newLine : line.oldLine))
    .filter((line): line is number => line !== null);
  return positions.length === 0
    ? null
    : { start: Math.min(...positions), end: Math.max(...positions) };
};

const classifyFileChange = (
  oldFile: string | null,
  newFile: string | null,
  renamed: boolean
): SemanticAnchorFileChange =>
  oldFile === null
    ? 'ADDITION'
    : newFile === null
      ? 'DELETION'
      : renamed || oldFile !== newFile
        ? 'RENAME'
        : 'MODIFICATION';

const displayPath = (oldFile: string | null, newFile: string | null): string =>
  newFile ?? oldFile ?? '<unknown>';

const changedLineHash = (side: 'add' | 'delete', body: string): string =>
  sha256(JSON.stringify(['semantic-anchor-changed-line-v1', side, body]));

/**
 * Compile a complete policy-eligible unified diff into rename-aware hunks and
 * context-separated change blocks. Hunk/block marker lines are additive, and
 * changed rows receive only a compact block-local coordinate immediately
 * after their +/- sign (`+A1 ...`, `-D1 ...`). Removing those annotations
 * reconstructs the original diff byte-for-byte without the transport cost of
 * a separate marker line for every changed row.
 */
export function buildSemanticAnchorChangeBlockCatalog(
  diffText: string,
  coverage: CoverageInput
): SemanticAnchorChangeBlockCatalog {
  const coverageByPosition = new Map<string, (typeof coverage.items)[number]>();
  for (const item of coverage.items) {
    const files = item.file.endsWith('\t') ? [item.file, item.file.slice(0, -1)] : [item.file];
    for (const file of files) {
      const key = positionKey(file, item.old_start ?? null, item.new_start ?? null);
      const prior = coverageByPosition.get(key);
      if (prior !== undefined && prior !== item)
        throw new Error(`coverage contains duplicate hunk position for ${file}`);
      coverageByPosition.set(key, item);
    }
  }

  const source = diffText.split('\n');
  const hunks: MutableChangeHunk[] = [];
  let oldFile: string | null = null;
  let newFile: string | null = null;
  let renamed = false;
  let currentHunk: MutableChangeHunk | null = null;
  let currentBlock: MutableChangeBlock | null = null;
  let oldLine = 0;
  let newLine = 0;
  let changedRowCount = 0;

  const closeBlock = () => {
    if (currentBlock === null || currentHunk === null) return;
    const hasAdds = currentBlock.lines.some((line) => line.side === 'add');
    const hasDeletes = currentBlock.lines.some((line) => line.side === 'delete');
    currentBlock.kind = hasAdds && hasDeletes ? 'REPLACEMENT' : hasAdds ? 'ADDITION' : 'DELETION';
    currentBlock.oldRange = blockRange(currentBlock.lines, 'delete');
    currentBlock.newRange = blockRange(currentBlock.lines, 'add');
    currentHunk.blocks.push(currentBlock);
    currentBlock = null;
  };

  const closeSection = () => {
    closeBlock();
    currentHunk = null;
    // Pure renames remain visible in the complete diff but contain no changed
    // rows, so they deliberately mint no semantic target block.
  };

  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index]!;
    if (raw.startsWith('diff --git ')) {
      closeSection();
      ({ oldFile, newFile } = gitHeaderPaths(raw));
      renamed = false;
      currentHunk = null;
      continue;
    }
    if (currentHunk === null && raw.startsWith('rename from ')) {
      oldFile = decodeGitPath(raw.slice('rename from '.length).trim());
      renamed = true;
      continue;
    }
    if (currentHunk === null && raw.startsWith('rename to ')) {
      newFile = decodeGitPath(raw.slice('rename to '.length).trim());
      renamed = true;
      continue;
    }
    if (currentHunk === null && raw.startsWith('--- ')) {
      oldFile = diffPath(raw.slice(4));
      continue;
    }
    if (currentHunk === null && raw.startsWith('+++ ')) {
      newFile = diffPath(raw.slice(4));
      continue;
    }
    const header = HUNK_RE.exec(raw);
    if (header !== null) {
      closeBlock();
      const coverageFile = newFile ?? oldFile;
      if (coverageFile === null) throw new Error(`diff hunk has no file: ${raw}`);
      const oldStart = Number(header[1]);
      const newStart = Number(header[2]);
      const item =
        coverageByPosition.get(positionKey(coverageFile, oldStart, newStart)) ??
        (oldStart === 0
          ? coverageByPosition.get(positionKey(coverageFile, null, newStart))
          : undefined) ??
        (newStart === 0
          ? coverageByPosition.get(positionKey(coverageFile, oldStart, null))
          : undefined);
      if (item === undefined)
        throw new Error(
          `diff hunk ${coverageFile}:${oldStart}:${newStart} has no coverage identity`
        );
      oldLine = oldStart;
      newLine = newStart;
      currentHunk = {
        sourceIndex: index,
        hunkKey: item.hunkKey,
        oldFile,
        newFile,
        displayPath: displayPath(oldFile, newFile),
        fileChange: classifyFileChange(oldFile, newFile, renamed),
        header: raw,
        blocks: [],
      };
      hunks.push(currentHunk);
      continue;
    }
    if (currentHunk === null) continue;
    if (raw.startsWith('+') || raw.startsWith('-')) {
      const side = raw.startsWith('+') ? 'add' : 'delete';
      if (currentBlock === null) {
        currentBlock = {
          sourceIndex: index,
          kind: side === 'add' ? 'ADDITION' : 'DELETION',
          oldRange: null,
          newRange: null,
          lines: [],
          lineSourceIndexes: [],
          addCount: 0,
          deleteCount: 0,
        };
      }
      const body = raw.slice(1);
      const ref =
        side === 'add' ? `A${(currentBlock.addCount += 1)}` : `D${(currentBlock.deleteCount += 1)}`;
      currentBlock.lines.push({
        ref,
        side,
        oldLine: side === 'delete' ? oldLine : null,
        newLine: side === 'add' ? newLine : null,
        body,
        lineHash: changedLineHash(side, body),
        noNewline: false,
      });
      currentBlock.lineSourceIndexes.push(index);
      changedRowCount += 1;
      if (side === 'add') newLine += 1;
      else oldLine += 1;
      continue;
    }
    if (raw === '\\ No newline at end of file') {
      const preceding = currentBlock?.lines.at(-1);
      if (preceding !== undefined) preceding.noNewline = true;
      continue;
    }
    if (raw.startsWith(' ')) {
      closeBlock();
      oldLine += 1;
      newLine += 1;
      continue;
    }
    closeBlock();
    currentHunk = null;
  }
  closeSection();

  const blockAliases: Record<string, string> = {};
  const hunkAliases: Record<string, string> = {};
  const completed = hunks.map((hunk, hunkIndex): SemanticAnchorChangeHunk => {
    const alias = `h${hunkIndex + 1}`;
    hunkAliases[alias] = hunk.hunkKey;
    const blocks = hunk.blocks.map((block, blockIndex): SemanticAnchorChangeBlock => {
      const blockAlias = `${alias}.b${blockIndex + 1}`;
      const blockKey = semanticAnchorChangeBlockKey({
        oldFile: hunk.oldFile,
        newFile: hunk.newFile,
        hunkKey: hunk.hunkKey,
        oldRange: block.oldRange,
        newRange: block.newRange,
        changedLines: block.lines,
      });
      blockAliases[blockAlias] = blockKey;
      return {
        alias: blockAlias,
        blockKey,
        kind: block.kind,
        oldRange: block.oldRange,
        newRange: block.newRange,
        lines: block.lines,
      };
    });
    return {
      alias,
      hunkKey: hunk.hunkKey,
      oldFile: hunk.oldFile,
      newFile: hunk.newFile,
      displayPath: hunk.displayPath,
      fileChange: hunk.fileChange,
      header: hunk.header,
      blocks,
    };
  });

  const markers = new Map<number, string[]>();
  const rowRefs = new Map<number, string>();
  const addMarker = (index: number, marker: string) => {
    const at = Math.max(0, Math.min(index, source.length));
    markers.set(at, [...(markers.get(at) ?? []), marker]);
  };
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const mutable = hunks[hunkIndex]!;
    const hunk = completed[hunkIndex]!;
    addMarker(mutable.sourceIndex, `@@@ change-hunk:${hunk.alias} ${hunk.fileChange} @@@`);
    for (let blockIndex = 0; blockIndex < mutable.blocks.length; blockIndex += 1) {
      const completedBlock = hunk.blocks[blockIndex]!;
      addMarker(
        mutable.blocks[blockIndex]!.sourceIndex,
        `@@@ change-block:${completedBlock.alias} ${completedBlock.kind} old:${canonicalRangeKey(completedBlock.oldRange)} new:${canonicalRangeKey(completedBlock.newRange)} @@@`
      );
      for (let lineIndex = 0; lineIndex < completedBlock.lines.length; lineIndex += 1)
        rowRefs.set(
          mutable.blocks[blockIndex]!.lineSourceIndexes[lineIndex]!,
          completedBlock.lines[lineIndex]!.ref
        );
    }
  }
  const rendered: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index]!;
    const rowRef = rowRefs.get(index);
    rendered.push(
      ...(markers.get(index) ?? []),
      rowRef === undefined ? raw : `${raw[0]}${rowRef} ${raw.slice(1)}`
    );
  }
  rendered.push(...(markers.get(source.length) ?? []));

  return {
    text: rendered.join('\n'),
    hunkCount: completed.length,
    blockCount: completed.reduce((count, hunk) => count + hunk.blocks.length, 0),
    changedRowCount,
    hunks: completed,
    blockAliases,
    hunkAliases,
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const positionKey = (file: string, oldStart: number | null, newStart: number | null): string =>
  `${file}\u0000${oldStart ?? ''}\u0000${newStart ?? ''}`;

function renderCitation(
  citation: SemanticAnchorCitation,
  aliasByCitationId: ReadonlyMap<string, string>
): string {
  return [
    `### ${citation.alias}`,
    '',
    `kind: ${citation.kind}`,
    ...(citation.parent !== undefined
      ? [`parent: ${aliasByCitationId.get(citation.parent) ?? citation.parent}`]
      : []),
    ...(citation.checkpoint_ref !== undefined
      ? [`checkpoint_ref: ${citation.checkpoint_ref}`]
      : []),
    '',
    '```text',
    citation.text,
    '```',
  ].join('\n');
}

function renderPayload(
  input: SemanticAnchorPreparationInput,
  citations: readonly SemanticAnchorCitation[],
  catalog: SemanticAnchorChangeBlockCatalog,
  compactStory: CompactSemanticAnchorStory,
  inventory: readonly SemanticAnchorExclusionEntry[],
  scope: NonNullable<SemanticAnchorInputReceipt['target_scope']>
): string {
  const aliasByCitationId = new Map(citations.map((citation) => [citation.id, citation.alias]));
  return [
    '# Semantic anchor input v4',
    '',
    '## Run identity',
    '',
    `run_id: ${input.runId}`,
    `floor_input_hash: ${input.accountProjection!.floor_input_hash}`,
    `profile: ${SEMANTIC_ANCHOR_PROFILE}`,
    '',
    '## Policy-eligible target space',
    '',
    'Only change blocks in this payload are valid targets. The exclusion inventory is',
    'a global disclosure and does not imply that any citation refers to an excluded file.',
    '',
    '```json',
    JSON.stringify({ ...scope, exclusions: inventory }, null, 2),
    '```',
    '',
    '## Accepted Story topology',
    '',
    '```json',
    JSON.stringify(compactStory, null, 2),
    '```',
    '',
    `## Eligible account items (${citations.length})`,
    '',
    ...citations.flatMap((citation, index) => [
      renderCitation(citation, aliasByCitationId),
      ...(index === citations.length - 1 ? [] : ['']),
    ]),
    '',
    `## Change-block diff (${catalog.hunkCount} hunks, ${catalog.blockCount} blocks, ${catalog.changedRowCount} changed rows)`,
    '',
    'Associate item aliases (i1, i2, ...) with complete change-block aliases',
    '(h1.b1, h1.b2, ...). Hunk and block aliases are prompt-local routing names;',
    'the engine resolves them to durable identities. Every original eligible diff line is present.',
    '',
    '```diff',
    catalog.text,
    '```',
    '',
  ].join('\n');
}

/** Build the complete prepared input or return a loud, non-blocking refusal receipt. */
export function prepareSemanticAnchorInput(
  input: SemanticAnchorPreparationInput
): SemanticAnchorPreparation {
  const profile = input.profile ?? SEMANTIC_ANCHOR_PROFILE_V1;
  if (
    input.storyModel === null ||
    input.storyModelBytes === null ||
    input.storyModel.label === 'CODE_ONLY' ||
    input.storyModel.parts.length === 0
  )
    return emptyReceipt(input, 'NOT_ELIGIBLE', 'CORE_STORY_ABSENT');
  if (input.accountProjection === null || input.accountProjectionBytes === null)
    return emptyReceipt(input, 'UNAVAILABLE', 'ACCOUNT_PROJECTION_UNAVAILABLE');
  if (input.accountLineage === null)
    return emptyReceipt(input, 'UNAVAILABLE', 'ACCOUNT_LINEAGE_UNAVAILABLE');
  const citations = collectEligibleSemanticAnchorCitations(input.accountProjection);
  if (citations.length === 0) return emptyReceipt(input, 'NOT_ELIGIBLE', 'NO_ELIGIBLE_CITATIONS');
  if (input.coverage === null || input.coverageBytes === null)
    return emptyReceipt(input, 'UNAVAILABLE', 'COVERAGE_UNAVAILABLE');
  if (input.pinnedDiffText === null)
    return emptyReceipt(input, 'UNAVAILABLE', 'PINNED_DIFF_UNAVAILABLE');
  if (input.forensicInput === null || input.forensicInputBytes === null)
    return emptyReceipt(input, 'UNAVAILABLE', 'FORENSIC_INPUT_UNAVAILABLE');

  const derived = derivedInputs(input);
  if (derived.compactStory === null || derived.inventory === null || derived.scope === null)
    return emptyReceipt(input, 'UNAVAILABLE', 'PREPARATION_FAILED', 'derived input absent');
  const blockCatalog = buildSemanticAnchorChangeBlockCatalog(
    input.forensicInput.diff,
    input.coverage
  );
  if (blockCatalog.blockCount === 0)
    return emptyReceipt(input, 'NOT_ELIGIBLE', 'NO_CHANGED_ROWS', null, {
      eligible: citations.length,
      hunks: blockCatalog.hunkCount,
      blocks: blockCatalog.blockCount,
    });

  const payload = renderPayload(
    input,
    citations,
    blockCatalog,
    derived.compactStory,
    derived.inventory,
    derived.scope
  );
  const payloadBytes = Buffer.byteLength(payload);
  const estimatedTokens = Math.ceil(payloadBytes / profile.estimated_token_divisor_bytes);
  const minimumOutputBytes = Buffer.byteLength(
    JSON.stringify({
      schema_version: 3,
      dispositions: [],
    })
  );
  const estimatedMinimumOutputTokens = Math.ceil(
    minimumOutputBytes / profile.estimated_token_divisor_bytes
  );
  const usableTokens = usableInputTokens(profile);
  const tooLarge =
    payloadBytes > profile.hard_transport_bytes ||
    estimatedTokens > usableTokens ||
    estimatedMinimumOutputTokens > profile.maximum_output_tokens;
  const receipt = semanticAnchorInputReceiptSchema.parse({
    schema_version: SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION,
    status: tooLarge ? 'TOO_LARGE' : 'READY',
    reason: tooLarge
      ? payloadBytes > profile.hard_transport_bytes
        ? 'HARD_TRANSPORT_BYTES_EXCEEDED'
        : estimatedTokens > usableTokens
          ? 'ESTIMATED_TOKEN_BUDGET_EXCEEDED'
          : 'MINIMUM_OUTPUT_BUDGET_EXCEEDED'
      : null,
    error_message: null,
    run_id: input.runId,
    floor_input_hash: input.accountProjection.floor_input_hash,
    profile: profile.profile,
    profile_source: profile.profile_source,
    budget: budgetReceipt(profile),
    source_hashes: sourceHashes(input),
    derivation_hashes: {
      ...derived.hashes,
      change_block_catalog_sha256: sha256(JSON.stringify(blockCatalog)),
    },
    target_scope: derived.scope,
    payload_file: tooLarge ? null : SEMANTIC_ANCHOR_INPUT_FILE,
    payload_sha256: sha256(payload),
    payload_bytes: payloadBytes,
    estimated_input_tokens: estimatedTokens,
    estimated_minimum_output_tokens: estimatedMinimumOutputTokens,
    usable_input_tokens: usableTokens,
    eligible_citation_count: citations.length,
    hunk_count: blockCatalog.hunkCount,
    change_block_count: blockCatalog.blockCount,
    changed_row_count: blockCatalog.changedRowCount,
  });
  return {
    receipt,
    payload: tooLarge ? null : payload,
    items: citations,
    blockCatalog,
  };
}
