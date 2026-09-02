// The tier-1 deterministic dossier — the COMPLETE disk
// artifact plus the budgeted model-input projections for both lanes. Zero
// model calls. Determinism contract: byte-identical output under permutation
// of input ordering; `generated_at` is transport metadata outside the
// contract (same convention as the claim ledger).
//
// The diff is parsed into
// FILE SECTIONS with original byte slices — the forensic lane is built by
// slicing, never by synthesizing patches; binary / rename / mode-only
// changes are first-class file_index entries; both lanes carry a per-file
// coverage floor (stub inventory) so no changed file can vanish from both.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { isValidGlobSyntax, matchesAnyGlob } from '@orcaops/evaluator-protocol';
import { redactSecretsInUnifiedDiff } from '@orcaops/evaluator-protocol/secrets';
import { type Citation, CITATION_KIND, DISCLOSURE_CODE, type Floor } from '@orcaops/review-core';

import { CLAIM_LEDGER_ENTRY_KIND, type ClaimLedgerEntry } from './claimLedger.js';

/**
 * Dossier + account-projection schema version.
 *
 * 2 — the account core adds `planDecisions` with rejected alternatives,
 * `criterionEvidence`, and checkpoint `verification`. Evaluator verdicts use
 * the unambiguous `evaluatorRuns` field; v1 readers instead look for a
 * `verification` field containing evaluator records, so this is a breaking
 * schema change rather than an additive one.
 *
 * 3 — the protected account corpus and transport refusal semantics were
 * tightened without changing the model-authored Story contract.
 *
 * 4 — acceptance criteria carry `parent` = the plan-step citation they belong
 * to, and evaluator rows carry the floor's structured run metadata. Those
 * links let the account payload render the plan hierarchy locally and
 * summarize routine evaluator outcomes without scraping prose. Both were
 * introduced with explicit fallbacks for schema-3 projections missing them
 * (the fallbacks ended with the strict v4 cut: both fields are required, and
 * the review-state gate rejects any unsupported state).
 */
export const DOSSIER_SCHEMA_VERSION = 4;

/**
 * Forensic-payload envelope version — decoupled from the dossier/account
 * schema so the forensic contract can move on its own. Bumped to 2 when the
 * importance-scored overflow packer was deleted: the
 * verbatim eligible diff is now the ONLY path — no importance-based omission,
 * no `omittedTop`/`omittedCount`, no over-budget truncation. Deciding which
 * hunks matter IS review work; no lexical scorer may do it.
 */
export const FORENSIC_SCHEMA_VERSION = 2;

/**
 * The single ABSOLUTE transport ceiling (bytes) on the eligible forensic diff.
 * If the eligible diff exceeds it, the routine run REFUSES at start with a
 * machine-parseable size-degradation envelope — no payload is minted. There is
 * no truncation path: silent partial coverage is the named failure mode and is
 * made impossible by construction. Aligned with the `review.max_diff_bytes`
 * default so a diff that fits the collection cap fits the payload.
 */
export const FORENSIC_TRANSPORT_CEILING_BYTES = 2_000_000;

/**
 * The ABSOLUTE ceiling (bytes) on the PROTECTED account corpus — the captured
 * provenance no budget stage may reduce (`PROTECTED_ACCOUNT_FIELDS`). Over it
 * the routine run REFUSES exactly as the forensic lane does; there is no
 * clipping path, because clipping captured provenance is the failure this
 * surface exists to prevent. Half the forensic ceiling: account text is denser
 * per token than diff text, and it is sized so the largest observed corpus
 * (~184 KB) leaves roughly 5x headroom.
 */
export const ACCOUNT_CORPUS_CEILING_BYTES = 1_000_000;

/**
 * ALL risk-signal constants live here; the version number changes
 * when any constant does. Computed from the retained diff ONLY.
 */
export const RISK_SIGNALS_V1 = {
  version: 1,
  /**
   * STRUCTURAL tier — drives selection and ranking; language-blind by
   * construction (changed-line magnitude + cross-file identifier fan-out).
   */
  fanoutFileThreshold: 3,
  /** S1 stratum: hunks with <= this many changed lines are selected before
   * rank spending - one-line default flips can never be starved by bulk
   * refactors. */
  smallHunkMaxChanged: 3,
  /**
   * LEXICAL tier — annotation-only HINTS. Never selection, never ranking:
   * these are crude language-flavored scans (JS/TS-biased) surfaced as
   * labeled heuristics; optional language adapters may strengthen them
   * later, and nothing ever requires one.
   */
  hintPatterns: {
    'guard-change': /(^|\W)(if|switch|catch)(\W|$)|\?[^.?]*:/,
    'default-change': /[=:]\s*(['"][\w.-]*['"]|\d+(?:\.\d+)?|true|false|null)/,
  },
  persistencePathPatterns: [
    /(^|\/)migrations\//,
    /(^|\/)schema[^/]*$/i,
    /store[^/]*$/i,
    /serializ/i,
  ],
  generatedPathPatterns: [
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)yarn\.lock$/,
    /\.lock$/,
    /\.min\.[a-z]+$/,
  ],
  captureArtifactPatterns: [/(^|\/)\.orcaops\//],
  testBasenamePattern: /\.(test|spec)\.[^.]+$/,
  testDirSegments: new Set(['test', 'tests', 'spec', 'specs', '__tests__']),
  identifierPattern: /[A-Za-z_$][A-Za-z0-9_$]{2,}/g,
  minIdentifierLength: 3,
} as const;

export type RiskHintName =
  | 'guard-change'
  | 'default-change'
  | 'persistence-path'
  | 'test-anchor-absent'
  | 'new-surface'
  | 'symbol-fanout';

/**
 * The versioned token estimator. CALIBRATION is recalibrated from
 * API-reported usage; bump ESTIMATOR_VERSION whenever it changes.
 */
export const ESTIMATOR_VERSION = 1;
export const ESTIMATOR_CALIBRATION = 1.0;
export const estimatorV1 = (text: string): number =>
  Math.ceil((text.length / 4) * ESTIMATOR_CALIBRATION);

/**
 * Budget caps, in estimator tokens. Every cap here is scoped to REDUCIBLE
 * content only: the protected corpus (`PROTECTED_ACCOUNT_FIELDS`) is never
 * measured against a budget, because there is no stage that could act on the
 * result. An oversized protected corpus refuses (`AccountCorpusCeilingError`)
 * rather than degrades. Hunks render with whatever context the retained diff
 * carries.
 */
export interface DossierBudget {
  /**
   * Threshold at which the ledger's late trim fires, measured on the projected
   * LEDGER ALONE. Measuring the whole core (the pre-carve-out `accountCore`)
   * made the condition permanently true once the corpus was complete, so every
   * stage fired on every real build.
   */
  ledgerReduction: number;
  implicatedHunks: number;
  riskRemainder: number;
  /**
   * Cap on the sections the total-cap loop can actually act on — implicated
   * hunks, the risk remainder, the file inventory, and the ledger. Measuring
   * the COMPLETE projection here meant a complete corpus (~40k tokens) held the
   * condition true forever, so the loop evicted every hunk from the account
   * lane and recorded `account-total-cap-exceeded` on every real branch.
   */
  accountProjectionTotal: number;
  forensicInputTotal: number;
  ledgerCitedTextClip: number;
}

/**
 * Full profile. `accountProjectionTotal` is sized from the largest observed
 * corpus: its reducible sections land at ~16.6k tokens (ledger 7.6k +
 * the two section caps + inventory), so 20k is a genuine backstop with ~20%
 * headroom rather than a condition that is true on every build.
 */
export const DOSSIER_BUDGET_V1: DossierBudget = {
  ledgerReduction: 8_000,
  implicatedHunks: 7_000,
  riskRemainder: 2_000,
  accountProjectionTotal: 20_000,
  forensicInputTotal: 30_000,
  ledgerCitedTextClip: 400,
};

/**
 * Routine profile. A per-lane ~8k target is unreachable under the protected
 * corpus carve-out: the protected corpus alone measures ~34k tokens on a large
 * branch and rides on top of every cap here, complete. The reducible sections measure
 * ~9.6k on that branch (ledger 6.6k after the late trim + the two section caps
 * + inventory), so 12k leaves ~25% headroom — enough that the total cap does
 * not fire, and therefore does not evict code, on an ordinary build.
 */
export const ROUTINE_BUDGET_V1: DossierBudget = {
  ledgerReduction: 4_000,
  implicatedHunks: 2_000,
  riskRemainder: 1_000,
  accountProjectionTotal: 12_000,
  forensicInputTotal: 8_000,
  ledgerCitedTextClip: 240,
};

export type FileChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary' | 'meta-only';

/** Annotation-only lexical hint — carries NO selection or ranking weight. */
export interface RiskHint {
  hint: RiskHintName;
  evidence: string;
}

export interface DossierHunk {
  id: string;
  file: string;
  header: string;
  adds: number;
  dels: number;
  span: number;
  /** Original diff bytes: the @@ line plus body lines, verbatim. */
  raw: string;
  /** Structural score: changed lines. Language-blind. */
  score: number;
  fanout: boolean;
  /** Generated-file annotation: deprioritized (rank last), never removed. */
  generated: boolean;
  /** Lexical hints — labeled heuristics, excluded from all selection math. */
  hints: RiskHint[];
  selection: 'implicated' | 'risk' | 'omitted' | 'capture-artifact';
}

/** Every changed file, including ones with no text hunks. */
export interface DossierFileEntry {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  changeType: FileChangeType;
  hunkCount: number;
  capture: boolean;
  generated: boolean;
  topSignal: string | null;
}

export interface DossierDecision {
  citationId: string;
  cp: number | null;
  text: string;
  alternatives: { citationId: string; text: string }[];
}

export interface DossierCheckpoint {
  artifact: string;
  cp: number;
  /** Pinned minimum: lifecycle status, never dropped by budget reduction. */
  status: 'closed';
  label: string | null;
  summary: string | null;
  decisions: DossierDecision[];
  uncertainty: { citationId: string; text: string }[];
}

export interface DossierLedgerEntry extends ClaimLedgerEntry {
  /** citation id -> verbatim cited capture text (projection compacts this). */
  citedText: Record<string, string>;
}

export interface DossierEvaluatorRun {
  citationId: string;
  text: string;
  /**
   * Structured provenance copied from the floor citation, which requires it on
   * every evaluator-run citation. Presentation must never scrape `text` to
   * infer outcomes, so the metadata rides with every row.
   */
  evaluator: NonNullable<Citation['evaluator']>;
}

export interface DossierAccountCore {
  checkpoints: DossierCheckpoint[];
  planSteps: { citationId: string; text: string }[];
  nonGoals: { citationId: string; text: string }[];
  /**
   * Plan-time architectural decisions with their rejected alternatives nested
   * under the decision each was ruled out against (`cp` is null — a plan
   * decision belongs to a revision, not a checkpoint).
   */
  planDecisions: DossierDecision[];
  /**
   * Plan-time acceptance criteria. `parent` names the plan-step citation the
   * criterion belongs to; the floor schema requires it.
   */
  acceptanceCriteria: { citationId: string; text: string; parent: string }[];
  /**
   * Close-time evidence for one acceptance criterion. `parent` is the
   * `acceptanceCriteria` citation id it evidences, ABSENT when the
   * `criterion_id` resolves to no criterion in scope — the evidence is served
   * either way, never dropped for want of a link.
   */
  criterionEvidence: { citationId: string; text: string; parent?: string }[];
  /**
   * Verified-close records (`verification[]`): commands run fresh at close with
   * their exit codes. Until this field landed the name held EVALUATOR RUNS —
   * see `evaluatorRuns` below, which is what that data actually was.
   */
  verification: { citationId: string; text: string }[];
  /**
   * Evaluator-log runs. Named `verification` until it was renamed: it never
   * held checkpoint verification, and the conflation produced a measurement
   * error that read evaluator verdicts as proof-of-execution.
   */
  evaluatorRuns: DossierEvaluatorRun[];
  ledger: DossierLedgerEntry[];
}

/**
 * The PROTECTED CORPUS: captured provenance, served complete or not at all.
 * No budget-reduction stage may clip, evict, aggregate, or count-summarize any
 * field named here — the reduction stages are typed against
 * `ReducibleAccountCore`, so touching one is a compile error, not a review
 * finding.
 */
export const PROTECTED_ACCOUNT_FIELDS = [
  'checkpoints',
  'planSteps',
  'nonGoals',
  'planDecisions',
  'acceptanceCriteria',
  'criterionEvidence',
  'verification',
  'evaluatorRuns',
] as const satisfies readonly Exclude<keyof ProjectionAccountCore, keyof ReducibleAccountCore>[];

/** The ONLY part of the account core budget reduction may touch. */
type ReducibleAccountCore = Pick<ProjectionAccountCore, 'ledger'>;

/** The protected corpus as a type — what the corpus ceiling measures. */
type ProtectedAccountCore = Pick<ProjectionAccountCore, (typeof PROTECTED_ACCOUNT_FIELDS)[number]>;

/**
 * Compile-time partition proof: protected ∪ reducible IS the whole account
 * core. Adding a field to `ProjectionAccountCore` without classifying it
 * resolves this to `never` and fails `ACCOUNT_CORE_PARTITIONED` below — a new
 * field cannot ship un-classified, silently unprotected.
 */
export type AccountCorePartition = ProtectedAccountCore &
  ReducibleAccountCore extends ProjectionAccountCore
  ? true
  : never;
export const ACCOUNT_CORE_PARTITIONED: AccountCorePartition = true;

/**
 * The protected corpus of a projected core — what the account ceiling measures
 * and what its refusal reports, byte for byte. Projected from
 * `PROTECTED_ACCOUNT_FIELDS` rather than a second hand-written field list, so
 * the ceiling can never drift from the carve-out; key order follows the const,
 * which keeps the serialization deterministic.
 */
const protectedAccountCorpus = (core: ProjectionAccountCore): ProtectedAccountCore =>
  Object.fromEntries(
    PROTECTED_ACCOUNT_FIELDS.map((field) => [field, core[field]])
  ) as ProtectedAccountCore;

export interface TruncationRecord {
  id: string;
  section: 'account-core' | 'implicated' | 'risk-remainder' | 'forensic-diff' | 'file-index';
  reason: 'budget' | 'binary' | 'generated' | 'clip' | 'capture-artifact' | 'meta-only';
  originalSize: number;
}

export interface DossierV1 {
  schema_version: typeof DOSSIER_SCHEMA_VERSION;
  branch: string;
  base_sha: string | null;
  floor_input_hash: string;
  retained_diff_hash: string;
  /** Canonical hash over COMPLETE ledger entries, not just ids. */
  ledger_hash: string;
  risk_signals_version: number;
  estimator_version: number;
  generated_at: string;
  account_core: DossierAccountCore;
  /**
   * Closed checkpoints excluded from the attribution chain because a boundary
   * snapshot is missing (floor disclosure `manifestless_checkpoint`).
   *
   * Carried so review.md can report it BESIDE the unattributed row total,
   * never divided into it. The engine knows both numbers and nothing about the
   * relationship between them: how many rows a snapshot-less checkpoint would
   * have owned is exactly what the missing snapshot destroyed.
   */
  missing_boundary_checkpoints: number;
  file_index: DossierFileEntry[];
  code_index: DossierHunk[];
  truncation_manifest: TruncationRecord[];
}

export interface ManifestSummary {
  counts: Record<string, number>;
  topOmittedHunks: { id: string; file: string; score: number }[];
}

/** Coverage-floor stub: a changed file with no full hunk in the projection. */
export interface FileInventoryStub {
  path: string;
  changeType: FileChangeType;
  hunkCount: number;
  topSignal: string | null;
}

export interface ProjectionLedgerEntry {
  id: string;
  kind: ClaimLedgerEntry['kind'];
  status: ClaimLedgerEntry['status'];
  message: string;
  citations: string[];
  anchors: string[];
  anchorsOmitted?: number;
  anchorTotal?: number;
  citedFallback: Record<string, string>;
  memberCount?: number;
  /** A group id may be cited to FLAG members, never to resolve them. */
  flagOnly?: true;
  /** sha16 over sorted member ids — the stable group identity witness. */
  memberDigest?: string;
  sampleMemberIds?: string[];
}

export interface ProjectionAccountCore extends Omit<DossierAccountCore, 'ledger'> {
  ledger: ProjectionLedgerEntry[];
}

export interface AccountProjection {
  schema_version: typeof DOSSIER_SCHEMA_VERSION;
  branch: string;
  floor_input_hash: string;
  /**
   * Artifact-uuid alias table (alias -> full uuid), applied inside every
   * citation id and checkpoint artifact field in this projection. Pure
   * serialization compaction; the disk dossier and manifest keep full ids.
   */
  artifactAliases: Record<string, string>;
  accountCore: ProjectionAccountCore;
  implicatedHunks: { id: string; file: string; raw: string }[];
  riskRemainder: { id: string; file: string; raw: string; score: number }[];
  /**
   * Coverage floor (ladder): full stub lines, or PATH-ONLY lines, or a
   * directory rollup — rollup mode is recorded coverage degradation.
   */
  fileInventory: string[];
  inventoryMode: InventoryMode;
  manifestSummary: ManifestSummary;
}

/**
 * A `review.stub_paths` policy stub: a changed
 * file an EXPLICIT, human-authored committed policy holds out of the verbatim
 * forensic diff. Enumerated with counts, never carried in `diff`. The reason is
 * always `review.stub_paths` — there is no heuristic, importance-scored, or
 * implicit path to this bucket.
 */
export interface PolicyStub {
  /** Repo-relative path (newPath ?? oldPath ?? section path). */
  path: string;
  /** Added rows across the file's hunks (0 for meta-only). */
  adds: number;
  /** Deleted rows across the file's hunks. */
  dels: number;
  /** Bytes the verbatim section slice WOULD have added to the eligible diff. */
  bytes: number;
  /** Which policy stubbed the section: a malformed stub path, or an exclude. */
  reason: 'review.stub_paths' | 'capture.exclude';
}

/**
 * Payload row accounting: every changed file lands in
 * exactly one of FOUR mutually exclusive buckets — eligible-verbatim, excluded
 * (capture internals), unreviewable (binaries), or policy-stubbed
 * (`review.stub_paths`) — and the four counts always sum to the changed-file
 * total, so no row can be silently dropped.
 */
export interface ForensicMetrics {
  /** Files mechanically represented in `diff` (verbatim, incl. generated). */
  eligibleFiles: number;
  /** Capture internals (the `.orcaops/` tree etc.) — categorically excluded. */
  excludedFiles: number;
  /** True binaries — enumerated by path; no reviewable text, not in `diff`. */
  unreviewableFiles: number;
  /** Files held out by an explicit `review.stub_paths` policy — not in `diff`. */
  policyStubFiles: number;
  /** Added+deleted rows across the policy-stubbed files (residue, not dropped). */
  policyStubRows: number;
  /** Bytes the policy-stubbed sections WOULD have consumed had they been carried. */
  policyStubBytes: number;
  /** Byte length of the eligible verbatim diff (the transport-ceiling measure). */
  eligibleDiffBytes: number;
}

export interface ForensicInput {
  schema_version: typeof FORENSIC_SCHEMA_VERSION;
  /** base/head shas only — never a branch name. */
  baseSha: string | null;
  /**
   * The COMPLETE eligible diff: original byte slices (never synthesized
   * patches) of every non-capture changed file, in original order,
   * verbatim. Generated files and lockfiles stay mechanically represented
   * here by default — importance-based omission is banned.
   */
  diff: string;
  /** Capture-internal paths categorically excluded from the payload. */
  excludedPaths: string[];
  /** True-binary paths: enumerated but not in `diff` (no reviewable text). */
  unreviewablePaths: string[];
  /**
   * Files stubbed by the explicit `review.stub_paths` policy: enumerated with
   * per-file counts, NOT carried verbatim in `diff`, and their bytes do NOT
   * count against the transport ceiling. Empty when no policy is configured.
   */
  policyStubs: PolicyStub[];
  /** Eligible / excluded / unreviewable / policy-stubbed row accounting. */
  metrics: ForensicMetrics;
}

const payloadString = z.string();
const payloadCount = z.number().int().nonnegative();
const payloadCitationTextSchema = z.strictObject({
  citationId: payloadString,
  text: payloadString,
});
const payloadEvaluatorSchema = z.strictObject({
  evaluator_ref: payloadString,
  severity: z.enum(['info', 'warn', 'block']),
  run_status: z.enum(['completed', 'error', 'skipped']),
  verdict: z.enum(['pass', 'violation', 'info']).nullable(),
  disposition: z.enum(['unresolved', 'acknowledged', 'dismissed', 'policy-excepted']).nullable(),
  summary: payloadString,
});
const payloadDecisionSchema = z.strictObject({
  citationId: payloadString,
  cp: z.number().int().positive().nullable(),
  text: payloadString,
  alternatives: z.array(payloadCitationTextSchema),
});
const payloadCheckpointSchema = z.strictObject({
  artifact: payloadString,
  cp: z.number().int().positive(),
  status: z.literal('closed'),
  label: payloadString.nullable(),
  summary: payloadString.nullable(),
  decisions: z.array(payloadDecisionSchema),
  uncertainty: z.array(payloadCitationTextSchema),
});
const payloadLedgerEntrySchema = z.strictObject({
  id: payloadString,
  kind: z.enum(CLAIM_LEDGER_ENTRY_KIND),
  status: z.enum(['CANDIDATE', 'INCONCLUSIVE']),
  message: payloadString,
  citations: z.array(payloadString),
  anchors: z.array(payloadString),
  evidence: z.record(payloadString, z.unknown()),
  citedText: z.record(payloadString, payloadString),
});
const payloadEvaluatorRunSchema = z.strictObject({
  citationId: payloadString,
  text: payloadString,
  evaluator: payloadEvaluatorSchema,
});
const payloadAccountCoreFields = {
  checkpoints: z.array(payloadCheckpointSchema),
  planSteps: z.array(payloadCitationTextSchema),
  nonGoals: z.array(payloadCitationTextSchema),
  planDecisions: z.array(payloadDecisionSchema),
  acceptanceCriteria: z.array(payloadCitationTextSchema.extend({ parent: payloadString })),
  criterionEvidence: z.array(
    payloadCitationTextSchema.extend({ parent: payloadString.optional() })
  ),
  verification: z.array(payloadCitationTextSchema),
  evaluatorRuns: z.array(payloadEvaluatorRunSchema),
} as const;
const dossierAccountCoreSchema = z.strictObject({
  ...payloadAccountCoreFields,
  ledger: z.array(payloadLedgerEntrySchema),
});
const projectionLedgerEntrySchema = z.strictObject({
  id: payloadString,
  kind: z.enum(CLAIM_LEDGER_ENTRY_KIND),
  status: z.enum(['CANDIDATE', 'INCONCLUSIVE']),
  message: payloadString,
  citations: z.array(payloadString),
  anchors: z.array(payloadString),
  anchorsOmitted: payloadCount.optional(),
  anchorTotal: payloadCount.optional(),
  citedFallback: z.record(payloadString, payloadString),
  memberCount: payloadCount.optional(),
  flagOnly: z.literal(true).optional(),
  memberDigest: payloadString.optional(),
  sampleMemberIds: z.array(payloadString).optional(),
});
const projectionAccountCoreSchema = z.strictObject({
  ...payloadAccountCoreFields,
  ledger: z.array(projectionLedgerEntrySchema),
});
const fileChangeTypeSchema = z.enum([
  'added',
  'deleted',
  'modified',
  'renamed',
  'binary',
  'meta-only',
]);
const dossierFileEntrySchema = z.strictObject({
  path: payloadString,
  oldPath: payloadString.nullable(),
  newPath: payloadString.nullable(),
  changeType: fileChangeTypeSchema,
  hunkCount: payloadCount,
  capture: z.boolean(),
  generated: z.boolean(),
  topSignal: payloadString.nullable(),
});
const dossierHunkSchema = z.strictObject({
  id: payloadString,
  file: payloadString,
  header: payloadString,
  adds: payloadCount,
  dels: payloadCount,
  span: payloadCount,
  raw: payloadString,
  score: payloadCount,
  fanout: z.boolean(),
  generated: z.boolean(),
  hints: z.array(
    z.strictObject({
      hint: z.enum([
        'guard-change',
        'default-change',
        'persistence-path',
        'test-anchor-absent',
        'new-surface',
        'symbol-fanout',
      ]),
      evidence: payloadString,
    })
  ),
  selection: z.enum(['implicated', 'risk', 'omitted', 'capture-artifact']),
});
const truncationRecordSchema = z.strictObject({
  id: payloadString,
  section: z.enum(['account-core', 'implicated', 'risk-remainder', 'forensic-diff', 'file-index']),
  reason: z.enum(['budget', 'binary', 'generated', 'clip', 'capture-artifact', 'meta-only']),
  originalSize: payloadCount,
});

/** Exact runtime contract for the current deterministic dossier artifact. */
export const dossierV1Schema: z.ZodType<DossierV1> = z.strictObject({
  schema_version: z.literal(DOSSIER_SCHEMA_VERSION),
  branch: payloadString,
  base_sha: payloadString.nullable(),
  floor_input_hash: payloadString,
  retained_diff_hash: payloadString,
  ledger_hash: payloadString,
  risk_signals_version: payloadCount,
  estimator_version: payloadCount,
  generated_at: z.iso.datetime(),
  account_core: dossierAccountCoreSchema,
  missing_boundary_checkpoints: payloadCount,
  file_index: z.array(dossierFileEntrySchema),
  code_index: z.array(dossierHunkSchema),
  truncation_manifest: z.array(truncationRecordSchema),
});

/** Exact runtime contract for the current account-lane projection artifact. */
export const accountProjectionSchema: z.ZodType<AccountProjection> = z.strictObject({
  schema_version: z.literal(DOSSIER_SCHEMA_VERSION),
  branch: payloadString,
  floor_input_hash: payloadString,
  artifactAliases: z.record(payloadString, payloadString),
  accountCore: projectionAccountCoreSchema,
  implicatedHunks: z.array(
    z.strictObject({ id: payloadString, file: payloadString, raw: payloadString })
  ),
  riskRemainder: z.array(
    z.strictObject({
      id: payloadString,
      file: payloadString,
      raw: payloadString,
      score: payloadCount,
    })
  ),
  fileInventory: z.array(payloadString),
  inventoryMode: z.enum(['full', 'paths', 'rollup']),
  manifestSummary: z.strictObject({
    counts: z.record(payloadString, payloadCount),
    topOmittedHunks: z.array(
      z.strictObject({ id: payloadString, file: payloadString, score: payloadCount })
    ),
  }),
});

/** Exact runtime contract for the current forensic-lane input artifact. */
export const forensicInputSchema: z.ZodType<ForensicInput> = z.strictObject({
  schema_version: z.literal(FORENSIC_SCHEMA_VERSION),
  baseSha: payloadString.nullable(),
  diff: payloadString,
  excludedPaths: z.array(payloadString),
  unreviewablePaths: z.array(payloadString),
  policyStubs: z.array(
    z.strictObject({
      path: payloadString,
      adds: payloadCount,
      dels: payloadCount,
      bytes: payloadCount,
      reason: z.enum(['review.stub_paths', 'capture.exclude']),
    })
  ),
  metrics: z.strictObject({
    eligibleFiles: payloadCount,
    excludedFiles: payloadCount,
    unreviewableFiles: payloadCount,
    policyStubFiles: payloadCount,
    policyStubRows: payloadCount,
    policyStubBytes: payloadCount,
    eligibleDiffBytes: payloadCount,
  }),
});

function parsePayloadJson<T>(source: string, raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `${source} is not a valid current payload: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export const parseDossierV1Json = (raw: string, source = 'dossier-v1.json'): DossierV1 =>
  parsePayloadJson(source, raw, dossierV1Schema);

export const parseAccountProjectionJson = (
  raw: string,
  source = 'account-projection-v1.json'
): AccountProjection => parsePayloadJson(source, raw, accountProjectionSchema);

export const parseForensicInputJson = (
  raw: string,
  source = 'forensic-input-v1.json'
): ForensicInput => parsePayloadJson(source, raw, forensicInputSchema);

export interface BuildDossierInput {
  floor: Floor;
  retainedDiff: string;
  ledgerEntries: readonly ClaimLedgerEntry[];
  branch: string;
  baseSha?: string | null;
  generatedAt: string;
  budget?: DossierBudget;
  /** Absolute transport ceiling for the eligible forensic diff (bytes). */
  forensicTransportCeilingBytes?: number;
  /** Absolute ceiling for the protected account corpus (bytes). */
  accountCorpusCeilingBytes?: number;
  /**
   * Explicit `review.stub_paths` policy globs. A changed file matching any
   * pattern is held out of the verbatim forensic diff as a loud stub line.
   * Each entry must be a non-empty valid glob; a malformed entry throws
   * `StubPolicyError` before any payload is built. Empty/absent ⇒ zero-config
   * byte-identical behavior.
   */
  stubPaths?: readonly string[];
  /**
   * `capture.exclude` globs. Matching files are held out of the payload an
   * agent reads, disclosed as stubs rather than silently dropped.
   */
  excludePaths?: readonly string[];
}

export interface BuildDossierResult {
  dossier: DossierV1;
  accountProjection: AccountProjection;
  forensicInput: ForensicInput;
  markdown: string;
}

export class DossierBudgetError extends Error {
  readonly inventory: { id: string; section: string; size: number }[];
  constructor(message: string, inventory: { id: string; section: string; size: number }[]) {
    super(message);
    this.name = 'DossierBudgetError';
    this.inventory = inventory;
  }
}

/**
 * The refusal: the eligible forensic diff exceeds the absolute
 * transport ceiling. Thrown from `buildDossier` BEFORE any artifact is
 * written, so no payload is minted. Carries the ceiling and the actual size
 * for a machine-parseable size-degradation envelope.
 */
export class ForensicTransportCeilingError extends Error {
  readonly code = 'FORENSIC_TRANSPORT_CEILING';
  readonly ceilingBytes: number;
  readonly actualBytes: number;
  constructor(ceilingBytes: number, actualBytes: number) {
    super(
      `forensic payload refused: the eligible diff is ${actualBytes} bytes, over the ${ceilingBytes}-byte transport ceiling — no payload minted (narrow the review scope, stub committed corpora / fixtures via review.stub_paths, or raise the ceiling / review.max_diff_bytes)`
    );
    this.name = 'ForensicTransportCeilingError';
    this.ceilingBytes = ceilingBytes;
    this.actualBytes = actualBytes;
  }
}

/**
 * The account-lane twin of the transport refusal: the PROTECTED account corpus
 * exceeds its absolute ceiling. Thrown from `buildDossier` BEFORE any artifact
 * is written, so no payload is minted. There is deliberately no degradation
 * path — the protected corpus is served complete or the run refuses. Reports
 * BYTES, exactly like the forensic refusal, so both render through the same
 * envelope. `forensicOverage` names a simultaneous transport overage in the
 * MESSAGE (never a second code): an operator over both ceilings learns both in
 * one round trip instead of narrowing scope twice.
 */
export class AccountCorpusCeilingError extends Error {
  readonly code = 'ACCOUNT_CORPUS_CEILING';
  readonly ceilingBytes: number;
  readonly actualBytes: number;
  constructor(
    ceilingBytes: number,
    actualBytes: number,
    forensicOverage?: { ceilingBytes: number; actualBytes: number }
  ) {
    super(
      `account payload refused: the captured account corpus is ${actualBytes} bytes, over the ${ceilingBytes}-byte account ceiling — no payload minted (the captured account is never clipped; narrow the review scope to fewer checkpoints, or raise the ceiling)` +
        (forensicOverage === undefined
          ? ''
          : `; the eligible forensic diff is ALSO over its ceiling at ${forensicOverage.actualBytes} bytes against ${forensicOverage.ceilingBytes} — both must be resolved`)
    );
    this.name = 'AccountCorpusCeilingError';
    this.ceilingBytes = ceilingBytes;
    this.actualBytes = actualBytes;
  }
}

/**
 * The other refusal: the live base→pinned review diff was
 * truncated at `review.max_diff_bytes`, so the floor already covers only a
 * partial diff. The routine surface refuses rather than mint a payload over
 * partial coverage — silent partial coverage is the named failure mode. The
 * true diff size is unknowable at the cap, so `actualBytes` is null.
 */
export class ReviewDiffTruncatedError extends Error {
  readonly code = 'REVIEW_DIFF_TRUNCATED';
  readonly ceilingBytes: number | null;
  readonly actualBytes = null;
  constructor(disclosureMessage: string, ceilingBytes: number | null) {
    super(
      `review refused: ${disclosureMessage}; no payload minted (raise review.max_diff_bytes or narrow the review scope)`
    );
    this.name = 'ReviewDiffTruncatedError';
    this.ceilingBytes = ceilingBytes;
  }
}

export class ExcludePolicyError extends Error {
  readonly code = 'CAPTURE_EXCLUDE_INVALID';
  readonly invalidPatterns: string[];
  constructor(invalidPatterns: readonly string[]) {
    super(
      `capture.exclude policy is malformed: ${invalidPatterns.length} invalid pattern(s) ` +
        `[${invalidPatterns.map((p) => JSON.stringify(p)).join(', ')}] — each entry must be a ` +
        `non-empty valid glob; no payload minted (fix or remove the entry in capture.exclude)`
    );
    this.name = 'ExcludePolicyError';
    this.invalidPatterns = [...invalidPatterns];
  }
}

/**
 * The stub-policy refusal: a `review.stub_paths` entry is malformed (empty or a
 * syntactically invalid glob). Thrown from `buildDossier` at routine-start
 * BEFORE any artifact is written, so no payload is minted — a malformed policy
 * fails LOUDLY and is never silently skipped. Carries the offending patterns for
 * a machine-parseable envelope.
 */
export class StubPolicyError extends Error {
  readonly code = 'STUB_POLICY_INVALID';
  readonly invalidPatterns: string[];
  constructor(invalidPatterns: readonly string[]) {
    super(
      `review.stub_paths policy is malformed: ${invalidPatterns.length} invalid pattern(s) ` +
        `[${invalidPatterns.map((p) => JSON.stringify(p)).join(', ')}] — each entry must be a ` +
        `non-empty valid glob; no payload minted (fix or remove the entry in review.stub_paths)`
    );
    this.name = 'StubPolicyError';
    this.invalidPatterns = [...invalidPatterns];
  }
}

/**
 * Validate a `review.stub_paths` policy: every entry must be a non-empty,
 * syntactically valid glob. Returns the offending entries (empty ⇒ valid). The
 * single source of truth for stub-policy validity, shared by the routine-start
 * verbs and `buildDossier`'s internal guard.
 */
export function invalidStubPatterns(patterns: readonly string[]): string[] {
  return patterns.filter((p) => !isValidGlobSyntax(p));
}

const codePointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha256hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const sha16 = (text: string): string => sha256hex(text).slice(0, 16);

// ---------------------------------------------------------------------------
// File-section diff parsing: original byte slices, both paths,
// non-text changes first-class.
// ---------------------------------------------------------------------------

interface SectionHunk {
  headerLine: string;
  raw: string;
  adds: number;
  dels: number;
  span: number;
  changedBodies: string[];
  addedBodies: string[];
  changedTokens: Set<string>;
}

interface FileSection {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  changeType: FileChangeType;
  headerBlock: string;
  hunks: SectionHunk[];
  capture: boolean;
  generated: boolean;
}

/** Git quotes paths containing spaces/specials: "a/x y" with C escapes. */
const GIT_ESCAPES: Record<string, string> = {
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
const unquoteGitPath = (p: string): string => {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  // Git C-quoting: named escapes + OCTAL byte runs for non-ASCII. Literal
  // characters (including literal UTF-8) are preserved AS CHARACTERS;
  // only octal runs are byte-assembled and UTF-8 decoded; decoding
  // byte-per-code-unit corrupts literal multi-byte characters such as `é`.
  const inner = p.slice(1, -1);
  let out = '';
  let octalBytes: number[] = [];
  const flushOctal = () => {
    if (octalBytes.length > 0) {
      out += Buffer.from(octalBytes).toString('utf8');
      octalBytes = [];
    }
  };
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      flushOctal();
      out += ch;
      continue;
    }
    const next = inner[i + 1] ?? '';
    if (next >= '0' && next <= '7') {
      let oct = '';
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && inner[j]! >= '0' && inner[j]! <= '7') {
        oct += inner[j];
        j += 1;
      }
      octalBytes.push(parseInt(oct, 8));
      i = j - 1;
    } else {
      flushOctal();
      out += GIT_ESCAPES[next] ?? next;
      i += 1;
    }
  }
  flushOctal();
  return out;
};
const stripDiffPath = (raw: string): string | null => {
  const p = unquoteGitPath(raw.trim());
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
};

function matchesAny(path: string | null, patterns: readonly RegExp[]): boolean {
  return path !== null && patterns.some((re) => re.test(path));
}

export function parseFileSections(diffText: string): FileSection[] {
  const lines = diffText.split('\n');
  const hasGitHeaders = lines.some((l) => l.startsWith('diff --git '));
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) starts.push(i);
    // Pure headerless fragments: a ---/+++ pair starts each file section.
    // (Only when NO git headers exist anywhere — inside git output a '--- '
    // hunk-body line is a deletion of '-- ...' and must not split.)
    else if (
      !hasGitHeaders &&
      line.startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1]!.startsWith('+++ ')
    )
      starts.push(i);
  }
  // Fallback for headerless fragments beginning directly with ---.
  const sections: FileSection[] = [];
  for (let s = 0; s < starts.length; s += 1) {
    const begin = starts[s]!;
    const end = s + 1 < starts.length ? starts[s + 1]! : lines.length;
    let hunkStart = end;
    for (let i = begin; i < end; i += 1) {
      if (lines[i]!.startsWith('@@')) {
        hunkStart = i;
        break;
      }
    }
    const headerLines = lines.slice(begin, hunkStart);
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renamed = false;
    let binary = false;
    for (const line of headerLines) {
      if (line.startsWith('--- ')) oldPath = stripDiffPath(line.slice(4).trim());
      else if (line.startsWith('+++ ')) newPath = stripDiffPath(line.slice(4).trim());
      else if (line.startsWith('rename from ')) {
        oldPath = unquoteGitPath(line.slice('rename from '.length).trim());
        renamed = true;
      } else if (line.startsWith('rename to ')) {
        newPath = unquoteGitPath(line.slice('rename to '.length).trim());
        renamed = true;
      } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
    }
    if (oldPath === null && newPath === null) {
      const header = headerLines[0] ?? '';
      // Quoted form first (paths with spaces): diff --git "a/x y" "b/x y"
      const q = /^diff --git ("a\/(?:[^"\\]|\\.)+") ("b\/(?:[^"\\]|\\.)+")$/.exec(header);
      const m = q ?? /^diff --git a\/(.+) b\/(.+)$/.exec(header);
      if (q) {
        // Quotes INCLUDED in the captures so the decoder actually runs
        // Stripping the quotes here would bypass `unquoteGitPath`.
        oldPath = stripDiffPath(q[1]!);
        newPath = stripDiffPath(q[2]!);
      } else if (m) {
        oldPath = m[1] ?? null;
        newPath = m[2] ?? null;
      }
    }
    const hunks: SectionHunk[] = [];
    let i = hunkStart;
    while (i < end) {
      if (!lines[i]!.startsWith('@@')) {
        i += 1;
        continue;
      }
      const headerLine = lines[i]!;
      const bodyStart = i;
      i += 1;
      while (i < end && !lines[i]!.startsWith('@@')) i += 1;
      const rawLines = lines.slice(bodyStart, i);
      const body = rawLines.slice(1);
      const adds = body.filter((l) => l.startsWith('+')).length;
      const dels = body.filter((l) => l.startsWith('-')).length;
      const changedBodies = body
        .filter((l) => l.startsWith('+') || l.startsWith('-'))
        .map((l) => l.slice(1));
      const addedBodies = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
      const changedTokens = new Set<string>();
      for (const b of changedBodies) {
        for (const m of b.matchAll(RISK_SIGNALS_V1.identifierPattern)) {
          if (m[0].length >= RISK_SIGNALS_V1.minIdentifierLength) changedTokens.add(m[0]);
        }
      }
      hunks.push({
        headerLine,
        raw: rawLines.join('\n'),
        adds,
        dels,
        span: body.length,
        changedBodies,
        addedBodies,
        changedTokens,
      });
    }
    const path = newPath ?? oldPath ?? '(unknown)';
    const changeType: FileChangeType = binary
      ? 'binary'
      : oldPath === null
        ? 'added'
        : newPath === null
          ? 'deleted'
          : hunks.length === 0
            ? renamed
              ? 'renamed'
              : 'meta-only'
            : renamed
              ? 'renamed'
              : 'modified';
    sections.push({
      path,
      oldPath,
      newPath,
      changeType,
      headerBlock: headerLines.join('\n'),
      hunks,
      // Capture/generated classify on BOTH paths (a deleted .orcaops file
      // must still be excluded from the forensic lane).
      capture:
        matchesAny(oldPath, RISK_SIGNALS_V1.captureArtifactPatterns) ||
        matchesAny(newPath, RISK_SIGNALS_V1.captureArtifactPatterns),
      generated:
        matchesAny(oldPath, RISK_SIGNALS_V1.generatedPathPatterns) ||
        matchesAny(newPath, RISK_SIGNALS_V1.generatedPathPatterns),
    });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

interface ScoredHunk extends DossierHunk {
  fullDigest: string;
  sectionRef: FileSection;
  hunkRef: SectionHunk;
}

const isTestPath = (path: string): boolean => {
  const cfg = RISK_SIGNALS_V1;
  const base = path.split('/').pop() ?? path;
  if (cfg.testBasenamePattern.test(base)) return true;
  return path.split('/').some((seg) => cfg.testDirSegments.has(seg));
};

export function scoreSections(sections: FileSection[]): ScoredHunk[] {
  const cfg = RISK_SIGNALS_V1;
  // symbol-fanout (STRUCTURAL): exact changed-line token -> files where it appears.
  const identFiles = new Map<string, Set<string>>();
  for (const section of sections) {
    for (const hunk of section.hunks) {
      for (const ident of hunk.changedTokens) {
        let set = identFiles.get(ident);
        if (!set) identFiles.set(ident, (set = new Set()));
        set.add(section.path);
      }
    }
  }
  const fanoutIdents = [...identFiles.entries()]
    .filter(([, files]) => files.size >= cfg.fanoutFileThreshold)
    .map(([ident, files]) => ({ ident, count: files.size }))
    .sort((a, b) => codePointCompare(a.ident, b.ident));

  const testBases = new Set(
    sections
      .filter((s) => isTestPath(s.path))
      .map((s) => (s.path.split('/').pop() ?? '').split('.')[0] ?? '')
      .filter((b) => b.length >= 3)
  );

  const scored: ScoredHunk[] = [];
  for (const section of sections) {
    for (const hunk of section.hunks) {
      const hints: RiskHint[] = [];
      const push = (hint: RiskHintName, evidence: string) => hints.push({ hint, evidence });

      const fanned = fanoutIdents.find((f) => hunk.changedTokens.has(f.ident));
      if (fanned)
        push('symbol-fanout', `identifier '${fanned.ident}' changed across ${fanned.count} files`);
      const guardLine = hunk.changedBodies.find((b) => cfg.hintPatterns['guard-change'].test(b));
      if (guardLine !== undefined) push('guard-change', guardLine.trim().slice(0, 80));
      const defaultLine = hunk.changedBodies.find((b) =>
        cfg.hintPatterns['default-change'].test(b)
      );
      if (defaultLine !== undefined) push('default-change', defaultLine.trim().slice(0, 80));
      if (matchesAny(section.path, cfg.persistencePathPatterns))
        push('persistence-path', section.path);
      const sourceBase = (section.path.split('/').pop() ?? '').split('.')[0] ?? '';
      if (!isTestPath(section.path) && !testBases.has(sourceBase))
        push(
          'test-anchor-absent',
          `no changed test names ${section.path.split('/').pop() ?? section.path}`
        );
      const exportAdd = hunk.addedBodies.find((b) => /^\s*export\s/.test(b));
      if (section.changeType === 'added' || exportAdd !== undefined)
        push(
          'new-surface',
          section.changeType === 'added' ? 'new file' : (exportAdd ?? '').trim().slice(0, 80)
        );

      // STRUCTURAL score only: changed-line magnitude + fan-out bonus.
      // Changed-line magnitude determines the structural score; fan-out is
      // an ordering tiebreak and a hint, never score arithmetic.
      const fanout = fanned !== undefined;
      const score = hunk.adds + hunk.dels;
      const fullDigest = sha256hex(`${section.path}\0${hunk.headerLine}\0${hunk.raw}`);
      scored.push({
        id: fullDigest.slice(0, 16),
        fullDigest,
        file: section.path,
        header: hunk.headerLine,
        adds: hunk.adds,
        dels: hunk.dels,
        span: hunk.span,
        raw: hunk.raw,
        score,
        fanout,
        generated: section.generated,
        hints: hints.sort((a, b) => codePointCompare(a.hint, b.hint)),
        selection: section.capture ? 'capture-artifact' : 'omitted',
        sectionRef: section,
        hunkRef: hunk,
      });
    }
  }
  // Total order: score desc → path asc → FULL digest asc.
  // Generated files rank LAST (deprioritized, never removed).
  return scored.sort(
    (a, b) =>
      Number(a.generated) - Number(b.generated) ||
      b.score - a.score ||
      Number(b.fanout) - Number(a.fanout) ||
      codePointCompare(a.file, b.file) ||
      codePointCompare(a.fullDigest, b.fullDigest)
  );
}

// ---------------------------------------------------------------------------
// Account core from the floor
// ---------------------------------------------------------------------------

const citationsOf = <K extends Citation['kind']>(
  floor: Floor,
  kind: K
): Extract<Citation, { kind: K }>[] =>
  floor.citations
    .filter((c): c is Extract<Citation, { kind: K }> => c.kind === kind)
    .sort((a, b) => codePointCompare(a.id, b.id));

function buildAccountCore(
  floor: Floor,
  ledgerEntries: readonly ClaimLedgerEntry[]
): DossierAccountCore {
  const decisions = citationsOf(floor, CITATION_KIND.CHECKPOINT_DECISION);
  const alternatives = citationsOf(floor, CITATION_KIND.CHECKPOINT_ALTERNATIVE);
  const uncertainty = citationsOf(floor, CITATION_KIND.CHECKPOINT_UNCERTAINTY);
  const citationText = new Map(floor.citations.map((c) => [c.id, c.text]));

  const threads = [...floor.outline.threads].sort((a, b) => a.order - b.order);
  const checkpoints: DossierCheckpoint[] = [];
  for (const thread of threads) {
    for (const cp of [...thread.checkpoints].sort((a, b) => a.order - b.order)) {
      const { artifact, cp: n, label } = cp.checkpoint;
      const cpDecisions = decisions.filter((c) => c.artifact === artifact && c.cp === n);
      const cpAlternatives = alternatives.filter((a) => a.artifact === artifact && a.cp === n);
      // An alternative belongs to the one decision named by its required
      // current-contract parent, not every decision in the checkpoint.
      checkpoints.push({
        artifact,
        cp: n,
        // The outline is built from CLOSED checkpoints only (see outline.ts).
        status: 'closed',
        label: label ?? null,
        summary: cp.summary ?? null,
        decisions: cpDecisions.map((c) => ({
          citationId: c.id,
          cp: c.cp ?? null,
          text: c.text,
          alternatives: cpAlternatives
            .filter((a) => a.parent === c.id)
            .map((a) => ({ citationId: a.id, text: a.text })),
        })),
        uncertainty: uncertainty
          .filter((c) => c.artifact === artifact && c.cp === n)
          .map((c) => ({ citationId: c.id, text: c.text })),
      });
    }
  }

  const simple = (kind: Citation['kind']) =>
    citationsOf(floor, kind).map((c) => ({ citationId: c.id, text: c.text }));

  // Plan decisions: the artifact-scoped mirror of the checkpoint block above.
  // Alternatives attach by `parent` alone, exactly as they do there. No
  // unattributed bucket is needed at this level and adding one would be dead
  // code: PLAN_DECISION and PLAN_ALTERNATIVE were minted together in a single
  // `buildCitations` pass, so every plan alternative's parent resolves by
  // construction (there is no pre-`parent` floor carrying this kind, and the
  // producer-version bump rebuilds every cached floor).
  const planAlternatives = citationsOf(floor, CITATION_KIND.PLAN_ALTERNATIVE);
  const planDecisions: DossierDecision[] = citationsOf(floor, CITATION_KIND.PLAN_DECISION).map(
    (c) => ({
      citationId: c.id,
      cp: null,
      text: c.text,
      alternatives: planAlternatives
        .filter((a) => a.parent === c.id)
        .map((a) => ({ citationId: a.id, text: a.text })),
    })
  );

  // Criterion evidence carries its `parent` through to the payload so the lane
  // can show evidence beneath the criterion it evidences. An unresolved
  // criterion_id left `parent` unset upstream; the record still rides, and the
  // key is simply omitted rather than serialized as null.
  const criterionEvidence = citationsOf(floor, CITATION_KIND.CRITERION_EVIDENCE).map((c) => ({
    citationId: c.id,
    text: c.text,
    ...(c.parent !== undefined ? { parent: c.parent } : {}),
  }));

  // The floor schema requires `parent` on every acceptance criterion and the
  // loader rejects violations, so the plan hierarchy is always explicit here.
  const acceptanceCriteria = citationsOf(floor, CITATION_KIND.ACCEPTANCE_CRITERION).map((c) => ({
    citationId: c.id,
    text: c.text,
    parent: c.parent,
  }));

  const evaluatorRuns = citationsOf(floor, CITATION_KIND.EVALUATOR_RUN).map((c) => ({
    citationId: c.id,
    text: c.text,
    evaluator: c.evaluator,
  }));

  const ledger = [...ledgerEntries]
    .sort((a, b) => codePointCompare(a.id, b.id))
    .map((entry): DossierLedgerEntry => {
      const citedText: Record<string, string> = {};
      for (const cid of [...entry.citations].sort(codePointCompare)) {
        const text = citationText.get(cid);
        if (text !== undefined) citedText[cid] = text;
      }
      return { ...entry, citedText };
    });

  return {
    checkpoints,
    planSteps: simple(CITATION_KIND.PLAN_STEP),
    nonGoals: simple(CITATION_KIND.PLAN_NON_GOAL),
    planDecisions,
    acceptanceCriteria,
    criterionEvidence,
    verification: simple(CITATION_KIND.CHECKPOINT_VERIFICATION),
    evaluatorRuns,
    ledger,
  };
}

/** Implicated files: ledger/landmark anchors ∩ the diff's exact file set. */
function implicatedFiles(
  floor: Floor,
  ledgerEntries: readonly ClaimLedgerEntry[],
  diffFiles: ReadonlySet<string>
): Set<string> {
  const files = new Set<string>();
  const consider = (anchor: string | null | undefined) => {
    if (anchor !== null && anchor !== undefined && diffFiles.has(anchor)) files.add(anchor);
  };
  for (const entry of ledgerEntries) for (const anchor of entry.anchors) consider(anchor);
  for (const landmark of floor.landmarks) consider(landmark.ref?.file);
  return files;
}

const measure = (value: unknown): number => estimatorV1(JSON.stringify(value));

export type InventoryMode = 'full' | 'paths' | 'rollup';

/**
 * Bounded inventory ladder: full stubs -> PATH-ONLY lines
 * (per-file coverage preserved) -> directory rollup, which is recorded
 * COVERAGE DEGRADATION, never silently counted as per-file coverage.
 */
export function buildInventoryLadder(
  files: readonly DossierFileEntry[],
  stub: (f: DossierFileEntry) => string,
  budgetChars: number
): { lines: string[]; mode: InventoryMode; truncatedDirs: number; fileCount: number } {
  const full = files.map(stub);
  if (full.join('').length <= budgetChars)
    return { lines: full, mode: 'full', truncatedDirs: 0, fileCount: files.length };
  const paths = files.map((f) => f.path);
  if (paths.join('').length <= budgetChars)
    return { lines: paths, mode: 'paths', truncatedDirs: 0, fileCount: files.length };
  const byDir = new Map<string, { files: number; hunks: number }>();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/') + 1) : './';
    const agg = byDir.get(dir) ?? { files: 0, hunks: 0 };
    agg.files += 1;
    agg.hunks += f.hunkCount;
    byDir.set(dir, agg);
  }
  let rolled = [...byDir.entries()]
    .sort((a, b) => codePointCompare(a[0], b[0]))
    .map(([dir, agg]) => `${dir} — ${agg.files} file(s), ${agg.hunks} hunk(s)`);
  let truncatedDirs = 0;
  while (rolled.length > 1 && rolled.join('').length > budgetChars) {
    rolled = rolled.slice(0, -1);
    truncatedDirs += 1;
  }
  if (truncatedDirs > 0)
    rolled = [...rolled, `(+${truncatedDirs} more director${truncatedDirs === 1 ? 'y' : 'ies'})`];
  return { lines: rolled, mode: 'rollup', truncatedDirs, fileCount: files.length };
}

/**
 * Clip to AT MOST `max` characters, ellipsis included — appending the ellipsis
 * to a full `max`-char slice would make every clipped value `max + 1` long and
 * put every caller's budget quietly off by one. Applies to the reducible ledger
 * and the display markdown only — no protected field is clipped anywhere.
 */
const clipText = (text: string, max: number): { text: string; clipped: boolean } =>
  text.length <= max
    ? { text, clipped: false }
    : { text: `${text.slice(0, Math.max(0, max - 1))}…`, clipped: true };

// ---------------------------------------------------------------------------
// Account projection
// ---------------------------------------------------------------------------

interface ProjectionBuild {
  projection: AccountProjection;
  manifest: TruncationRecord[];
}

/**
 * Exported for REPLAY: rebuilding a projection over a pinned `DossierAccountCore`
 * from an archived run, without re-deriving a floor. That is what makes a
 * capture-completeness result controlled — same input bytes, new engine — rather
 * than a comparison against a branch that has since moved.
 */
export function buildAccountProjection(
  branch: string,
  floorHash: string,
  core: DossierAccountCore,
  hunks: ScoredHunk[],
  fileIndex: DossierFileEntry[],
  implicated: Set<string>,
  budget: DossierBudget
): ProjectionBuild {
  const manifest: TruncationRecord[] = [];
  for (const h of hunks) {
    if (h.selection === 'capture-artifact')
      manifest.push({
        id: h.id,
        section: 'risk-remainder',
        reason: 'capture-artifact',
        originalSize: measure(h.raw),
      });
  }
  for (const f of fileIndex) {
    if (f.changeType === 'binary')
      manifest.push({
        id: `file:${f.path}`,
        section: 'file-index',
        reason: 'binary',
        originalSize: 0,
      });
    else if (f.changeType === 'meta-only' || (f.changeType === 'renamed' && f.hunkCount === 0))
      manifest.push({
        id: `file:${f.path}`,
        section: 'file-index',
        reason: 'meta-only',
        originalSize: 0,
      });
  }

  const eligible = hunks.filter((h) => h.selection !== 'capture-artifact');
  const implicatedAll = eligible.filter((h) => implicated.has(h.file));
  const remainderAll = eligible.filter((h) => !implicated.has(h.file));

  // -- ledger compaction + grouping --
  const projectedCitationIds = new Set<string>([
    ...core.checkpoints.flatMap((cp) => [
      ...cp.decisions.flatMap((d) => [d.citationId, ...d.alternatives.map((a) => a.citationId)]),
      ...cp.uncertainty.map((u) => u.citationId),
    ]),
    ...core.planDecisions.flatMap((d) => [
      d.citationId,
      ...d.alternatives.map((a) => a.citationId),
    ]),
    ...core.planSteps.map((i) => i.citationId),
    ...core.nonGoals.map((i) => i.citationId),
    ...core.acceptanceCriteria.map((i) => i.citationId),
    ...core.criterionEvidence.map((i) => i.citationId),
    ...core.verification.map((i) => i.citationId),
    ...core.evaluatorRuns.map((i) => i.citationId),
  ]);
  const fallbackOf = (entry: DossierLedgerEntry): Record<string, string> => {
    const citedFallback: Record<string, string> = {};
    for (const [cid, text] of Object.entries(entry.citedText)) {
      if (projectedCitationIds.has(cid)) continue;
      const clipped = clipText(text, budget.ledgerCitedTextClip);
      citedFallback[cid] = clipped.text;
      if (clipped.clipped)
        manifest.push({
          id: `${entry.id}:${cid}`,
          section: 'account-core',
          reason: 'clip',
          originalSize: estimatorV1(text),
        });
    }
    return citedFallback;
  };
  /**
   * Keep one projected row per ledger row. Even when normalized messages
   * match, each row must retain its own ids, citations, anchors, and
   * attachments.
   */
  const projectLedger = (entries: DossierLedgerEntry[]): ProjectionLedgerEntry[] =>
    entries
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        message: entry.message,
        citations: entry.citations,
        anchors: entry.anchors,
        citedFallback: fallbackOf(entry),
      }))
      .sort((a, b) => codePointCompare(a.id, b.id));

  let projCore: ProjectionAccountCore = { ...core, ledger: projectLedger(core.ledger) };

  // Citation-id prefix compaction: ~500 refs x ~40 shared chars on real
  // floors. Stages measure the STRIPPED serialization (what the lane pays
  // for); the manifest and disk dossier keep full ids.
  const allIds = [
    ...projCore.checkpoints.flatMap((cp) => [
      ...cp.decisions.flatMap((d) => [d.citationId, ...d.alternatives.map((a) => a.citationId)]),
      ...cp.uncertainty.map((u) => u.citationId),
    ]),
    ...projCore.planDecisions.flatMap((d) => [
      d.citationId,
      ...d.alternatives.map((a) => a.citationId),
    ]),
    ...projCore.planSteps.map((i) => i.citationId),
    ...projCore.nonGoals.map((i) => i.citationId),
    ...projCore.acceptanceCriteria.flatMap((i) => [i.citationId, i.parent]),
    // `parent` ids are acceptance ids that already appear above; listing them
    // here too is harmless (the alias set is deduped) and keeps the enumeration
    // total if a parent ever names a citation outside acceptanceCriteria.
    ...projCore.criterionEvidence.flatMap((i) => [i.citationId, ...(i.parent ? [i.parent] : [])]),
    ...projCore.verification.map((i) => i.citationId),
    ...projCore.evaluatorRuns.map((i) => i.citationId),
    ...projCore.ledger.flatMap((e) => e.citations),
  ];
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const uuids = [
    ...new Set(
      allIds.map((id) => uuidRe.exec(id)?.[0]).filter((u): u is string => u !== undefined)
    ),
  ].sort(codePointCompare);
  const aliasOf = new Map(uuids.map((u, i) => [u, `a${i + 1}`]));
  const artifactAliases = Object.fromEntries(uuids.map((u, i) => [`a${i + 1}`, u]));
  const stripId = (id: string): string => {
    const m = uuidRe.exec(id);
    return m && aliasOf.has(m[0]) ? id.replace(m[0], aliasOf.get(m[0])!) : id;
  };
  const stripItem = <T extends { citationId: string }>(item: T): T => ({
    ...item,
    citationId: stripId(item.citationId),
  });
  const applyStrip = (c: ProjectionAccountCore): ProjectionAccountCore => ({
    ...c,
    checkpoints: c.checkpoints.map((cp) => ({
      ...cp,
      artifact: aliasOf.get(cp.artifact) ?? cp.artifact,
      decisions: cp.decisions.map((d) => ({
        ...stripItem(d),
        alternatives: d.alternatives.map(stripItem),
      })),
      uncertainty: cp.uncertainty.map(stripItem),
    })),
    planDecisions: c.planDecisions.map((d) => ({
      ...stripItem(d),
      alternatives: d.alternatives.map(stripItem),
    })),
    planSteps: c.planSteps.map(stripItem),
    nonGoals: c.nonGoals.map(stripItem),
    acceptanceCriteria: c.acceptanceCriteria.map((criterion) => ({
      ...stripItem(criterion),
      parent: stripId(criterion.parent),
    })),
    // `parent` is a citation id too — leaving it un-aliased would point the
    // evidence at a full-uuid id that appears nowhere else in the projection.
    criterionEvidence: c.criterionEvidence.map((e) => ({
      ...stripItem(e),
      ...(e.parent !== undefined ? { parent: stripId(e.parent) } : {}),
    })),
    verification: c.verification.map(stripItem),
    evaluatorRuns: c.evaluatorRuns.map(stripItem),
    ledger: c.ledger.map((e) => ({
      ...e,
      citations: e.citations.map(stripId),
      citedFallback: Object.fromEntries(
        Object.entries(e.citedFallback).map(([k, v]) => [stripId(k), v])
      ),
    })),
  });

  // Late ledger trim: group anchor lists to 5 and fallbacks to 160 chars,
  // recorded — the compact rows are already lossless-on-disk.
  const trimLedgerLate = (c: ReducibleAccountCore): ReducibleAccountCore => ({
    ...c,
    ledger: c.ledger.map((row) => {
      let next = row;
      if (row.anchors.length > 5) {
        manifest.push({
          id: `${row.id}:anchors-late`,
          section: 'account-core',
          reason: 'clip',
          originalSize: row.anchors.length,
        });
        next = {
          ...next,
          anchors: row.anchors.slice(0, 5),
          anchorsOmitted: (row.anchorTotal ?? row.anchors.length) - 5,
        };
      }
      const citedFallback: Record<string, string> = {};
      let trimmed = false;
      for (const [cid, text] of Object.entries(next.citedFallback)) {
        const clipped = clipText(text, 160);
        citedFallback[cid] = clipped.text;
        if (clipped.clipped) {
          trimmed = true;
          manifest.push({
            id: `${row.id}:${cid}:late`,
            section: 'account-core',
            reason: 'clip',
            originalSize: estimatorV1(text),
          });
        }
      }
      return trimmed || next !== row ? { ...next, citedFallback } : row;
    }),
  });

  /**
   * Budget reduction reaches the LEDGER AND NOTHING ELSE. Stages are typed
   * against `ReducibleAccountCore`, so a stage that touched a decision, a plan
   * step, an acceptance criterion, an evaluator run, or a checkpoint would not
   * compile. The ten-stage ladder this replaced clipped decision bodies to 41
   * characters, dropped every rejected alternative, and emptied acceptance
   * criteria and evaluator runs outright — and its `dropAlternatives` stage ran
   * BEFORE the degradation rungs, so a projection reporting no degradation had
   * still been gutted. Reduction is measured on the ledger ALONE: measured on
   * the whole core the condition is permanently true once the corpus is
   * complete, and every stage fires on every real build.
   */
  const reduceStages: ((c: ReducibleAccountCore) => ReducibleAccountCore)[] = [trimLedgerLate];
  let stageIdx = 0;
  while (
    measure(applyStrip(projCore).ledger) > budget.ledgerReduction &&
    stageIdx < reduceStages.length
  ) {
    projCore = { ...projCore, ...reduceStages[stageIdx]!(projCore) };
    stageIdx += 1;
  }
  // REFUSE, DO NOT DEGRADE: the deterministic inputs may be computed in memory
  // for pre-flight,
  // but an oversized account corpus refuses in `buildDossier` before a run is
  // minted or ANY run artifact is written — dossier and forensic input
  // included. The prior ruling degraded oversized mandatory content to an
  // aggregate mode, then a counts-only mode, so tier 1 always built; it always
  // built by serving a fabricated summary of the captured account in place of
  // the account. A payload that cannot carry the captured record whole is not a
  // smaller review, it is a different one.

  /**
   * A hunk whose own row exceeds the WHOLE section cap can never be served in
   * that section, so evicting every smaller hunk to make room for it starves
   * the section to zero. A single hunk far larger than the section cap at the
   * head of the order makes evict-lowest pop every implicated hunk behind it
   * and still never fit — a second, independent way for the
   * account lane to ship no code. Oversized rows leave FIRST, with a record;
   * their files stay covered by the inventory floor, which is recomputed after.
   */
  const dropOversizedRows = (
    all: readonly ScoredHunk[],
    row: (h: ScoredHunk) => unknown,
    cap: number,
    section: TruncationRecord['section']
  ): ScoredHunk[] =>
    all.filter((h) => {
      if (measure([row(h)]) <= cap) return true;
      manifest.push({ id: h.id, section, reason: 'budget', originalSize: measure(h.raw) });
      return false;
    });

  // -- implicated hunks: evict lowest-rank-first until the SECTION fits --
  const toImplicated = (h: ScoredHunk) => ({ id: h.id, file: h.file, raw: h.raw });
  const implicatedSel = dropOversizedRows(
    implicatedAll,
    toImplicated,
    budget.implicatedHunks,
    'implicated'
  );
  while (
    implicatedSel.length > 0 &&
    measure(implicatedSel.map(toImplicated)) > budget.implicatedHunks
  ) {
    const evicted = implicatedSel.pop()!;
    manifest.push({
      id: evicted.id,
      section: 'implicated',
      reason: 'budget',
      originalSize: measure(evicted.raw),
    });
  }

  // -- risk remainder: candidate set then evict-lowest --
  const toRemainder = (h: ScoredHunk) => ({ id: h.id, file: h.file, raw: h.raw, score: h.score });
  // Order small hunks ahead of bulk so evict-lowest starves bulk refactors
  // before one-line changes.
  const remainderSmall = remainderAll.filter(
    (h) => !h.generated && h.adds + h.dels <= RISK_SIGNALS_V1.smallHunkMaxChanged
  );
  const remainderSmallSet = new Set(remainderSmall);
  const remainderSel = dropOversizedRows(
    [...remainderSmall, ...remainderAll.filter((h) => !remainderSmallSet.has(h))],
    toRemainder,
    budget.riskRemainder,
    'risk-remainder'
  );
  while (remainderSel.length > 0 && measure(remainderSel.map(toRemainder)) > budget.riskRemainder) {
    const evicted = remainderSel.pop()!;
    manifest.push({
      id: evicted.id,
      section: 'risk-remainder',
      reason: 'budget',
      originalSize: measure(evicted.raw),
    });
  }

  // -- coverage floor: recomputed on EVERY projection build so
  // total-cap evictions can never orphan a file from both hunks and stubs
  // (a stale inventory after the eviction stage would orphan a file from both
  // hunks and stubs) --
  const ACCOUNT_INVENTORY_CHAR_BUDGET = 6000;
  const accountStub = (f: DossierFileEntry): string =>
    `${f.path} — ${f.changeType}, ${f.hunkCount} hunk(s)${f.topSignal ? `, ${f.topSignal}` : ''}`;
  const computeFileInventory = () => {
    const carriedFiles = new Set([...implicatedSel, ...remainderSel].map((h) => h.file));
    const files = fileIndex
      .filter((f) => !carriedFiles.has(f.path) && !f.capture)
      .sort((a, b) => codePointCompare(a.path, b.path));
    return buildInventoryLadder(files, accountStub, ACCOUNT_INVENTORY_CHAR_BUDGET);
  };

  const summarize = (): ManifestSummary => {
    const counts: Record<string, number> = {};
    for (const rec of manifest) {
      const key = `${rec.section}:${rec.reason}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const byId = new Map(hunks.map((h) => [h.id, h]));
    const topOmittedHunks = manifest
      .filter((r) => r.reason === 'budget' && byId.has(r.id))
      .map((r) => byId.get(r.id)!)
      .sort((a, b) => b.score - a.score || codePointCompare(a.fullDigest, b.fullDigest))
      .slice(0, 10)
      .map((h) => ({ id: h.id, file: h.file, score: h.score }));
    return { counts, topOmittedHunks };
  };

  let inv = computeFileInventory();
  const buildProjection = (): AccountProjection => {
    inv = computeFileInventory();
    return {
      schema_version: DOSSIER_SCHEMA_VERSION,
      branch,
      floor_input_hash: floorHash,
      artifactAliases,
      accountCore: applyStrip(projCore),
      implicatedHunks: implicatedSel.map(toImplicated),
      riskRemainder: remainderSel.map(toRemainder),
      fileInventory: inv.lines,
      inventoryMode: inv.mode,
      manifestSummary: summarize(),
    };
  };

  /**
   * The total cap measures ONLY what its evictions can act on:
   * the two hunk sections, the file inventory, and the ledger. Measured on the
   * complete projection it would count the protected corpus too — on a large
   * branch that alone dwarfs the cap — so the condition would be permanently
   * true, the loop would evict every risk hunk and then every implicated hunk,
   * and the account lane would ship ZERO code while recording
   * `account-total-cap-exceeded` as if that were a rare edge. `inv` is
   * refreshed by `buildProjection`, so
   * the measure is read only where it is current.
   */
  const reducibleMeasure = (): number =>
    measure({
      implicatedHunks: implicatedSel.map(toImplicated),
      riskRemainder: remainderSel.map(toRemainder),
      fileInventory: inv.lines,
      ledger: applyStrip(projCore).ledger,
    });
  let projection = buildProjection();
  if (reducibleMeasure() > budget.accountProjectionTotal) {
    for (const h of remainderSel)
      manifest.push({
        id: h.id,
        section: 'risk-remainder',
        reason: 'budget',
        originalSize: measure(h.raw),
      });
    remainderSel.length = 0;
    projection = buildProjection();
    while (implicatedSel.length > 0 && reducibleMeasure() > budget.accountProjectionTotal) {
      const evicted = implicatedSel.pop()!;
      manifest.push({
        id: evicted.id,
        section: 'implicated',
        reason: 'budget',
        originalSize: measure(evicted.raw),
      });
      projection = buildProjection();
    }
    if (reducibleMeasure() > budget.accountProjectionTotal) {
      // The residual overage after every eviction and inventory-ladder step is
      // RECORDED, not thrown: what remains is the ledger and the coverage floor,
      // both of which the lane needs whole. Only the PROTECTED corpus refuses.
      manifest.push({
        id: 'account-total-cap-exceeded',
        section: 'account-core',
        reason: 'budget',
        originalSize: reducibleMeasure(),
      });
      projection = buildProjection();
    }
  }
  if (inv.mode !== 'full')
    manifest.push({
      id: `account-inventory-${inv.mode}`,
      section: 'account-core',
      reason: 'clip',
      originalSize: inv.fileCount,
    });
  return { projection, manifest };
}

// ---------------------------------------------------------------------------
// Forensic input — the COMPLETE eligible diff, verbatim
// ---------------------------------------------------------------------------
//
// There is no packer. Every changed file lands in exactly ONE of FOUR mutually
// exclusive buckets — eligible, excluded, unreviewable, or policy-stubbed — so
// no row can be silently dropped:
//   - EXCLUDED: capture internals (the `.orcaops/` tree), categorically out.
//   - UNREVIEWABLE: true binaries — no reviewable text, enumerated by path.
//   - POLICY-STUBBED: a changed file matching an explicit, human-authored
//     `review.stub_paths` glob — enumerated as a loud stub line (path, add/del
//     rows, bytes, reason), never carried verbatim, and its bytes do NOT count
//     against the transport ceiling. The ONLY reason a reviewable text file
//     leaves the verbatim diff. Not a heuristic; not importance-scored.
//   - ELIGIBLE: everything else, rendered VERBATIM in `diff` (original byte
//     slices, original order) — generated files and lockfiles included.
// Nothing is scored; nothing is dropped by importance. If the POST-STUB eligible
// diff exceeds the absolute transport ceiling the run REFUSES — never a partial
// diff.

/** True iff any of a section's non-null paths match a `review.stub_paths` glob. */
function sectionMatchesStub(s: FileSection, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  return (
    (s.newPath !== null && matchesAnyGlob(s.newPath, patterns)) ||
    (s.oldPath !== null && matchesAnyGlob(s.oldPath, patterns)) ||
    matchesAnyGlob(s.path, patterns)
  );
}

/**
 * The four-bucket split and the verbatim eligible diff — everything the
 * transport ceiling is measured against. Split out of `buildForensicInput` so
 * `buildDossier` can weigh the eligible bytes in its single pre-flight, BEFORE
 * either lane is built: a branch over both ceilings then learns about both from
 * one refusal instead of narrowing scope, re-running, and hitting the second.
 */
interface EligibleDiff {
  excludedPaths: string[];
  unreviewablePaths: string[];
  eligibleSections: FileSection[];
  policyStubs: PolicyStub[];
  diff: string;
  eligibleDiffBytes: number;
}

/**
 * The section set every PAYLOAD is built from.
 *
 * The exclude filter and the scrub both live inside `computeEligibleDiff`,
 * which feeds the forensic diff and nothing else — so an excluded path and an
 * unredacted credential reached `code_index`, the hint evidence and the account
 * projection in full, while the one payload a test happened to assert on was
 * clean. Treating the diff once, here, is what makes every sink agree.
 *
 * The scrub runs over the WHOLE document before parsing, which is the form
 * `redactSecretsInUnifiedDiff` is built for — scanning per hunk would leave a
 * key spanning two hunks unseen. Parsing afterwards is what keeps the derived
 * line arrays, and therefore the hint evidence, consistent with the raw text.
 *
 * An excluded file keeps its path and metadata so the stub inventory can still
 * disclose that it was withheld; only its content goes.
 */
function treatSectionsForPayload(
  retainedDiff: string,
  excludePatterns: readonly string[]
): FileSection[] {
  return parseFileSections(redactSecretsInUnifiedDiff(retainedDiff)).map((section) =>
    sectionMatchesStub(section, excludePatterns) ? { ...section, hunks: [] } : section
  );
}

function computeEligibleDiff(
  sections: FileSection[],
  stubPatterns: readonly string[],
  excludePatterns: readonly string[]
): EligibleDiff {
  const excludedPaths = [...new Set(sections.filter((s) => s.capture).map((s) => s.path))].sort(
    codePointCompare
  );
  const unreviewablePaths = [
    ...new Set(sections.filter((s) => !s.capture && s.changeType === 'binary').map((s) => s.path)),
  ].sort(codePointCompare);
  // Precedence: capture > binary > policy-stub > eligible. A policy stub only
  // ever holds out a reviewable TEXT file; capture internals and binaries keep
  // their categorical buckets (they never consumed the verbatim-diff budget).
  const reviewable = sections.filter((s) => !s.capture && s.changeType !== 'binary');
  // `capture.exclude` outranks `review.stub_paths`: one is a security control
  // with built-in defaults, the other a corpus-size tool. A file matching both
  // is reported under the reason that explains why it may not be read.
  const stubReasonFor = (s: FileSection): 'capture.exclude' | 'review.stub_paths' | null =>
    sectionMatchesStub(s, excludePatterns)
      ? 'capture.exclude'
      : sectionMatchesStub(s, stubPatterns)
        ? 'review.stub_paths'
        : null;
  const stubbed = reviewable.filter((s) => stubReasonFor(s) !== null);
  const eligible = reviewable.filter((s) => stubReasonFor(s) === null);

  // Policy-stub inventory: one entry per distinct path, counts summed (real
  // diffs carry unique paths; the fold stays correct if git ever repeats one).
  const stubByPath = new Map<string, PolicyStub>();
  for (const s of stubbed) {
    const adds = s.hunks.reduce((n, h) => n + h.adds, 0);
    const dels = s.hunks.reduce((n, h) => n + h.dels, 0);
    const bytes = Buffer.byteLength(
      [s.headerBlock, ...s.hunks.map((h) => h.raw)].join('\n'),
      'utf8'
    );
    const prior = stubByPath.get(s.path);
    if (prior === undefined)
      stubByPath.set(s.path, { path: s.path, adds, dels, bytes, reason: stubReasonFor(s)! });
    else
      stubByPath.set(s.path, {
        ...prior,
        adds: prior.adds + adds,
        dels: prior.dels + dels,
        bytes: prior.bytes + bytes,
      });
  }
  const policyStubs = [...stubByPath.values()].sort((a, b) => codePointCompare(a.path, b.path));

  // Verbatim path — the ONLY path: original section slices, original order.
  // Backstop behind the path filter above. A credential can sit in a tracked
  // file nobody thought to name, and this payload is read by an agent and
  // therefore by a model provider. Line-preserving by construction, so Part
  // ranges still resolve against the unredacted pinned diff.patch — measured
  // AFTER the scrub so the transport ceiling and the payload agree.
  const diff = redactSecretsInUnifiedDiff(
    eligible.map((s) => [s.headerBlock, ...s.hunks.map((h) => h.raw)].join('\n')).join('\n')
  );
  const eligibleDiffBytes = Buffer.byteLength(diff, 'utf8');

  return {
    excludedPaths,
    unreviewablePaths,
    eligibleSections: eligible,
    policyStubs,
    diff,
    eligibleDiffBytes,
  };
}

function buildForensicInput(
  baseSha: string | null,
  eligible: EligibleDiff,
  ceilingBytes: number
): ForensicInput {
  // Transport ceiling applies to the POST-STUB eligible bytes → refusal, never
  // truncation. Stubbed corpora no longer consume the budget. `buildDossier`
  // has already refused over this ceiling in its pre-flight; the check stays
  // here as a defensive invariant so the payload can never be built over it.
  if (eligible.eligibleDiffBytes > ceilingBytes)
    throw new ForensicTransportCeilingError(ceilingBytes, eligible.eligibleDiffBytes);

  return {
    schema_version: FORENSIC_SCHEMA_VERSION,
    baseSha,
    diff: eligible.diff,
    excludedPaths: eligible.excludedPaths,
    unreviewablePaths: eligible.unreviewablePaths,
    policyStubs: eligible.policyStubs,
    metrics: {
      eligibleFiles: eligible.eligibleSections.length,
      excludedFiles: eligible.excludedPaths.length,
      unreviewableFiles: eligible.unreviewablePaths.length,
      policyStubFiles: eligible.policyStubs.length,
      policyStubRows: eligible.policyStubs.reduce((n, s) => n + s.adds + s.dels, 0),
      policyStubBytes: eligible.policyStubs.reduce((n, s) => n + s.bytes, 0),
      eligibleDiffBytes: eligible.eligibleDiffBytes,
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown render (display only — complete data lives in dossier-v1.json)
// ---------------------------------------------------------------------------

function renderMarkdown(dossier: DossierV1): string {
  const c = dossier.account_core;
  const lines: string[] = [];
  lines.push(`# Review dossier — ${dossier.branch}`);
  lines.push('');
  lines.push(
    `Floor \`${dossier.floor_input_hash.slice(0, 12)}\` · diff \`${dossier.retained_diff_hash.slice(0, 12)}\` · ledger \`${dossier.ledger_hash.slice(0, 12)}\` · risk-signals v${dossier.risk_signals_version}`
  );
  lines.push('');
  lines.push(
    '_Display render: long texts are clipped here for reading; the complete record is dossier-v1.json._'
  );
  lines.push('');
  if (c.ledger.length > 0) {
    lines.push(`## Claim ledger (${c.ledger.length})`);
    lines.push('');
    for (const e of c.ledger) lines.push(`- **${e.kind}** [${e.status}] ${e.message}`);
    lines.push('');
  }
  lines.push(`## Account (${c.checkpoints.length} checkpoints)`);
  lines.push('');
  for (const cp of c.checkpoints) {
    lines.push(`### cp${cp.cp} — ${cp.label ?? '(no label)'}`);
    for (const d of cp.decisions) lines.push(`- decision: ${clipText(d.text, 200).text}`);
    for (const u of cp.uncertainty) lines.push(`- uncertainty: ${clipText(u.text, 200).text}`);
    lines.push('');
  }
  if (c.nonGoals.length > 0) {
    lines.push('## Non-goals');
    for (const n of c.nonGoals) lines.push(`- ${clipText(n.text, 200).text}`);
    lines.push('');
  }
  if (c.planDecisions.length > 0) {
    lines.push('## Plan decisions');
    for (const d of c.planDecisions) {
      lines.push(`- ${clipText(d.text, 200).text}`);
      for (const alt of d.alternatives) lines.push(`  - rejected: ${clipText(alt.text, 200).text}`);
    }
    lines.push('');
  }
  if (c.criterionEvidence.length > 0) {
    lines.push('## Done-criteria evidence');
    for (const e of c.criterionEvidence)
      lines.push(
        `- ${clipText(e.text, 200).text}${e.parent === undefined ? ' _(no criterion in scope)_' : ''}`
      );
    lines.push('');
  }
  if (c.verification.length > 0) {
    lines.push('## Verified close');
    for (const v of c.verification) lines.push(`- ${clipText(v.text, 200).text}`);
    lines.push('');
  }
  if (c.evaluatorRuns.length > 0) {
    lines.push('## Evaluator runs');
    for (const r of c.evaluatorRuns) lines.push(`- ${clipText(r.text, 200).text}`);
    lines.push('');
  }
  const top = dossier.code_index.filter((h) => h.score > 0).slice(0, 10);
  if (top.length > 0) {
    lines.push('## Top structural hunks (score = changed lines + fan-out bonus)');
    lines.push('');
    for (const h of top) {
      const hintNote =
        h.hints.length > 0 ? ` — hints: ${h.hints.map((x) => x.hint).join(', ')}` : '';
      lines.push(`- \`${h.file}\` ${h.header} score ${h.score}${hintNote}`);
    }
    lines.push('');
  }
  const nonText = dossier.file_index.filter((f) => f.hunkCount === 0);
  if (nonText.length > 0) {
    lines.push('## Non-text changes');
    for (const f of nonText) lines.push(`- \`${f.path}\` (${f.changeType})`);
    lines.push('');
  }
  lines.push(
    `_Truncation manifest: ${dossier.truncation_manifest.length} record(s); see dossier-v1.json._`
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildDossier(input: BuildDossierInput): BuildDossierResult {
  const budget = input.budget ?? DOSSIER_BUDGET_V1;
  const stubPaths = input.stubPaths ?? [];
  // Malformed policy fails LOUDLY at routine-start, before any payload work —
  // never a silent skip of a stub entry.
  const invalid = invalidStubPatterns(stubPaths);
  if (invalid.length > 0) throw new StubPolicyError(invalid);
  const sections = parseFileSections(input.retainedDiff);
  // Score from the TREATED set: everything a payload carries is derived from
  // `scored`, so the exclusion and the scrub have to be applied before it.
  const scored = scoreSections(
    treatSectionsForPayload(input.retainedDiff, input.excludePaths ?? [])
  );
  const topSignalByFile = new Map<string, string>();
  for (const h of scored) {
    if (topSignalByFile.has(h.file)) continue;
    if (h.fanout) topSignalByFile.set(h.file, 'symbol-fanout');
    else if (h.hints.length > 0) topSignalByFile.set(h.file, h.hints[0]!.hint);
  }
  const fileIndex: DossierFileEntry[] = sections
    .map((s) => ({
      path: s.path,
      oldPath: s.oldPath,
      newPath: s.newPath,
      changeType: s.changeType,
      hunkCount: s.hunks.length,
      capture: s.capture,
      generated: s.generated,
      topSignal: topSignalByFile.get(s.path) ?? null,
    }))
    .sort((a, b) => codePointCompare(a.path, b.path));

  const diffFiles = new Set<string>();
  for (const s of sections) {
    if (s.oldPath !== null) diffFiles.add(s.oldPath);
    if (s.newPath !== null) diffFiles.add(s.newPath);
  }

  // -- single pre-flight over BOTH absolute ceilings --
  // The eligible diff is measured FIRST so a simultaneous transport overage is
  // known by the time either refusal is raised; everything below this point is
  // in-memory only, and both refusals throw before `buildDossier` returns, so
  // no dossier, no projection, no forensic input, no run, and no model call
  // survives a refusal.
  const eligible = computeEligibleDiff(sections, stubPaths, input.excludePaths ?? []);
  const forensicCeiling = input.forensicTransportCeilingBytes ?? FORENSIC_TRANSPORT_CEILING_BYTES;
  const forensicOverage =
    eligible.eligibleDiffBytes > forensicCeiling
      ? { ceilingBytes: forensicCeiling, actualBytes: eligible.eligibleDiffBytes }
      : undefined;

  const core = buildAccountCore(input.floor, input.ledgerEntries);
  const implicated = implicatedFiles(input.floor, input.ledgerEntries, diffFiles);

  const { projection, manifest } = buildAccountProjection(
    input.branch,
    input.floor.input_hash,
    core,
    scored,
    fileIndex,
    implicated,
    budget
  );

  // The protected corpus is measured EXACTLY as the error reports it: the
  // served (alias-stripped) bytes of the fields no stage may touch.
  const accountCeiling = input.accountCorpusCeilingBytes ?? ACCOUNT_CORPUS_CEILING_BYTES;
  const corpusBytes = Buffer.byteLength(
    JSON.stringify(protectedAccountCorpus(projection.accountCore)),
    'utf8'
  );
  if (corpusBytes > accountCeiling)
    throw new AccountCorpusCeilingError(accountCeiling, corpusBytes, forensicOverage);
  if (forensicOverage !== undefined)
    throw new ForensicTransportCeilingError(forensicCeiling, eligible.eligibleDiffBytes);

  const forensicInput = buildForensicInput(input.baseSha ?? null, eligible, forensicCeiling);

  const implicatedIds = new Set(projection.implicatedHunks.map((h) => h.id));
  const riskIds = new Set(projection.riskRemainder.map((h) => h.id));
  const codeIndex: DossierHunk[] = scored.map((h) => ({
    id: h.id,
    file: h.file,
    header: h.header,
    adds: h.adds,
    dels: h.dels,
    span: h.span,
    raw: h.raw,
    score: h.score,
    fanout: h.fanout,
    hints: h.hints,
    generated: h.generated,
    selection:
      h.selection === 'capture-artifact'
        ? h.selection
        : implicatedIds.has(h.id)
          ? 'implicated'
          : riskIds.has(h.id)
            ? 'risk'
            : 'omitted',
  }));

  const sortedManifest = [...manifest].sort(
    (a, b) =>
      codePointCompare(a.section, b.section) ||
      codePointCompare(a.reason, b.reason) ||
      codePointCompare(a.id, b.id)
  );

  // Canonical hash over COMPLETE entries.
  const canonicalLedger = [...input.ledgerEntries]
    .sort((a, b) => codePointCompare(a.id, b.id))
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      status: e.status,
      message: e.message,
      citations: e.citations,
      anchors: e.anchors,
      evidence: e.evidence,
    }));

  const dossier: DossierV1 = {
    schema_version: DOSSIER_SCHEMA_VERSION,
    branch: input.branch,
    base_sha: input.baseSha ?? null,
    floor_input_hash: input.floor.input_hash,
    retained_diff_hash: sha16(input.retainedDiff),
    ledger_hash: sha16(JSON.stringify(canonicalLedger)),
    risk_signals_version: RISK_SIGNALS_V1.version,
    estimator_version: ESTIMATOR_VERSION,
    generated_at: input.generatedAt,
    account_core: core,
    // Counted from the floor's own disclosures, not re-derived: the attribution
    // ladder already emits one MANIFESTLESS_CHECKPOINT per closed checkpoint it
    // had to exclude for a failed snapshot.
    missing_boundary_checkpoints: input.floor.disclosure.filter(
      (d) => d.code === DISCLOSURE_CODE.MANIFESTLESS_CHECKPOINT
    ).length,
    file_index: fileIndex,
    code_index: codeIndex,
    truncation_manifest: sortedManifest,
  };

  const parsedDossier = dossierV1Schema.parse(dossier);
  const parsedProjection = accountProjectionSchema.parse(projection);
  const parsedForensicInput = forensicInputSchema.parse(forensicInput);
  return {
    dossier: parsedDossier,
    accountProjection: parsedProjection,
    forensicInput: parsedForensicInput,
    markdown: renderMarkdown(parsedDossier),
  };
}
