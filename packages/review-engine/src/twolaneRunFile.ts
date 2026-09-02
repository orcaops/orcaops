// The persisted two-lane run file (`run-v1.json`): its shape, its strict
// schema, and its single reader. Deliberately dependency-neutral — it imports
// from neither twolaneRunCli.ts (which writes the file) nor currentStory.ts
// (which cross-checks it against the run record), so both can consume the
// same strict contract without a cycle.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { type ExecutableIdentity, executableIdentitySchema } from '@orcaops/review-core';

import {
  SUBMISSION_NORMALIZATION_CODES,
  type SubmissionNormalizationCode,
} from './submissionNormalization.js';
import {
  type Lane,
  LANES,
  SLICE_DIAGNOSTIC_CODES,
  SLICE_LANE_OUTCOMES,
  SLICE_SCHEMA_VERSION,
  type SliceRunState,
} from './twolaneSlice.js';

/**
 * Version 2 = the launch strictness cut: `latency_input_bytes`,
 * `runtime_identity`, and `execution_profile` became required (the
 * pre-cut reader back-filled them). The contract change is version-named
 * so EVERY reader — gated or not — types a pre-cut file as
 * version-unsupported instead of a pile of shape issues. Existing v1 run
 * directories all sit behind review-state markers at or below 3, which
 * the gated readers reject wholesale; no ungated reader parses the
 * file directly (the branchless run locator and the watch app only
 * existence-check it), and any future one gets the version message from
 * the probes below. The file name (`run-v1.json`) is a stable container name; the
 * contract version lives here. Monotonic; never recycled.
 */
export const TWOLANE_RUN_SCHEMA_VERSION = 2;

export const TWOLANE_RUN_FILE = 'run-v1.json';

/**
 * run-record-v1.json contract version — independent of
 * TWOLANE_RUN_SCHEMA_VERSION (the strictness cut bumped the run FILE to
 * 2; the record's shape is unchanged). One exported definition so the
 * writer and every reader track the same literal.
 */
export const TWOLANE_RUN_RECORD_SCHEMA_VERSION = 1;

/** Single source of truth — the persisted run schema's z.enum derives from it. */
export const ISOLATION_VALUES = ['subagent-fresh', 'sequential', 'unknown'] as const;
export type DeclaredIsolation = (typeof ISOLATION_VALUES)[number];

export const EXECUTION_PROFILE_PROVENANCE = [
  'CALLER_DECLARED',
  'HOST_REPORTED',
  'EVALUATION_REGISTERED',
] as const;
export type ExecutionProfileProvenance = (typeof EXECUTION_PROFILE_PROVENANCE)[number];
export interface ExecutionProfileField {
  value: string;
  provenance: ExecutionProfileProvenance;
}
export interface TwolaneExecutionProfile {
  host: ExecutionProfileField | null;
  host_version: ExecutionProfileField | null;
  model: ExecutionProfileField | null;
  effort: ExecutionProfileField | null;
  launcher_mode: ExecutionProfileField | null;
  instruction_hash: ExecutionProfileField | null;
}
export const executionProfileFieldSchema = z
  .object({
    value: z.string().trim().min(1),
    provenance: z.enum(EXECUTION_PROFILE_PROVENANCE),
  })
  .strict();

export interface TwolaneAttemptRecord {
  lane: Lane;
  at: string;
  accepted: boolean;
  is_repair: boolean;
  declared_isolation: DeclaredIsolation;
  diagnostic_codes: string[];
  normalization_code: RoutineNormalizationSummaryCode;
  normalization_codes: RoutineNormalizationCode[];
  raw_submission_sha256: string;
  normalized_submission_sha256: string;
  compiled_payload_sha256: string | null;
  accepted_envelope_sha256: string | null;
  usage_tokens: number | null;
  usage_source: string | null;
}

export interface AccountSubmissionLineage {
  raw_submission_sha256: string;
  normalized_authored_sha256: string;
  compiled_payload_sha256: string;
  accepted_envelope_sha256: string;
  normalization_code: RoutineNormalizationSummaryCode;
  normalization_codes: RoutineNormalizationCode[];
  diagnostic_codes: string[];
}

export type RoutineNormalizationCode = SubmissionNormalizationCode;
export type RoutineNormalizationSummaryCode = RoutineNormalizationCode | 'MULTIPLE_NORMALIZATIONS';

export interface TwolaneRunFile {
  schema_version: typeof TWOLANE_RUN_SCHEMA_VERSION;
  run_id: string;
  branch: string;
  mode: 'routine';
  created_at: string;
  /** sha16 of each pinned input; the optional `coverage` key is present when the snapshot exists. */
  input_shas: Record<string, string>;
  slice_state: SliceRunState;
  lane_inputs_served: Partial<Record<Lane, string>>;
  attempts: TwolaneAttemptRecord[];
  account_lineage: AccountSubmissionLineage | null;
  /** Exact UTF-8 bytes of the policy-eligible forensic diff used to select the latency tier. */
  latency_input_bytes: number;
  /** Engine-observed identity of the executable that minted this run. */
  runtime_identity: ExecutableIdentity | null;
  /** Optional host/caller metadata. Unknown fields stay null and are never inferred. */
  execution_profile: TwolaneExecutionProfile;
  finalized: { at: string; outcome: 'FULL' | 'DEGRADED' | 'FAILED' } | null;
}

// Enum members below come from the source constant arrays, never re-typed by
// hand: a member added upstream flows into this reader instead of making it
// reject current-writer files.
const routineNormalizationCodeSchema = z.enum(SUBMISSION_NORMALIZATION_CODES);
const routineNormalizationSummaryCodeSchema = z.enum([
  ...routineNormalizationCodeSchema.options,
  'MULTIPLE_NORMALIZATIONS',
]);

const sliceDiagnosticSchema = z.strictObject({
  code: z.enum(SLICE_DIAGNOSTIC_CODES),
  message: z.string(),
});

const sliceLaneStateSchema = z.strictObject({
  attempts: z.number().int().nonnegative(),
  accepted: z.boolean(),
  repairCredit: z.number().int(),
  outcome: z.enum(SLICE_LANE_OUTCOMES),
  diagnostics: z.array(sliceDiagnosticSchema),
});

const sliceRunStateSchema = z.strictObject({
  schema_version: z.literal(SLICE_SCHEMA_VERSION),
  lanes: z.strictObject({
    account: sliceLaneStateSchema,
    forensic: sliceLaneStateSchema,
  }),
});

const twolaneAttemptRecordSchema = z.strictObject({
  lane: z.enum(LANES),
  at: z.string(),
  accepted: z.boolean(),
  is_repair: z.boolean(),
  declared_isolation: z.enum(ISOLATION_VALUES),
  diagnostic_codes: z.array(z.string()),
  normalization_code: routineNormalizationSummaryCodeSchema,
  normalization_codes: z.array(routineNormalizationCodeSchema),
  raw_submission_sha256: z.string(),
  normalized_submission_sha256: z.string(),
  compiled_payload_sha256: z.string().nullable(),
  accepted_envelope_sha256: z.string().nullable(),
  usage_tokens: z.number().nullable(),
  usage_source: z.string().nullable(),
});

const accountSubmissionLineageSchema = z.strictObject({
  raw_submission_sha256: z.string(),
  normalized_authored_sha256: z.string(),
  compiled_payload_sha256: z.string(),
  accepted_envelope_sha256: z.string(),
  normalization_code: routineNormalizationSummaryCodeSchema,
  normalization_codes: z.array(routineNormalizationCodeSchema),
  diagnostic_codes: z.array(z.string()),
});

/**
 * Persisted-profile contract, distinct from the caller-input schema in
 * twolaneRunCli.ts: the writer materializes every component key (null when
 * unknown), so a persisted profile with a missing key is corruption, not an
 * older mint.
 */
export const persistedExecutionProfileSchema = z.strictObject({
  host: executionProfileFieldSchema.nullable(),
  host_version: executionProfileFieldSchema.nullable(),
  model: executionProfileFieldSchema.nullable(),
  effort: executionProfileFieldSchema.nullable(),
  launcher_mode: executionProfileFieldSchema.nullable(),
  instruction_hash: executionProfileFieldSchema.nullable(),
});

/**
 * Lanes are spelled out so the schema keeps full inference. The `satisfies`
 * ties the keys to `Lane`: adding a lane to LANES (or misspelling one here)
 * is a compile error in this file rather than a silently unvalidated key.
 */
const laneInputsServedShape = {
  account: z.string().optional(),
  forensic: z.string().optional(),
} satisfies Record<(typeof LANES)[number], z.ZodOptional<z.ZodString>>;

/** The complete persisted run file. Every key the writer emits is required. */
export const twolaneRunFileSchema: z.ZodType<TwolaneRunFile> = z.strictObject({
  schema_version: z.literal(TWOLANE_RUN_SCHEMA_VERSION),
  run_id: z.string().min(1),
  branch: z.string(),
  mode: z.literal('routine'),
  created_at: z.string(),
  input_shas: z.record(z.string(), z.string()),
  slice_state: sliceRunStateSchema,
  lane_inputs_served: z.strictObject(laneInputsServedShape),
  attempts: z.array(twolaneAttemptRecordSchema),
  account_lineage: accountSubmissionLineageSchema.nullable(),
  latency_input_bytes: z.number().int().nonnegative(),
  runtime_identity: executableIdentitySchema.nullable(),
  execution_profile: persistedExecutionProfileSchema,
  finalized: z
    .strictObject({ at: z.string().datetime(), outcome: z.enum(['FULL', 'DEGRADED', 'FAILED']) })
    .nullable(),
});

/**
 * Thrown by the version probes below. Exported so boundary catches can
 * distinguish a run-file contract violation from an I/O error (ENOENT).
 */
export class TwolaneRunFileError extends Error {
  override readonly name = 'TwolaneRunFileError';
}

/**
 * The ONLY reader of the persisted run file — every consumer (the two-lane
 * verbs, the semantic-anchor path, and the current-Story pointer validation)
 * goes through the strict schema here, so a corrupt run file fails typed
 * instead of flowing on as an unchecked cast. Throws; callers that prefer a
 * softer disposition catch at their boundary.
 */
export async function readTwolaneRunFile(runDir: string): Promise<TwolaneRunFile> {
  const raw = await readFile(path.join(runDir, TWOLANE_RUN_FILE), 'utf8');
  let decoded: {
    schema_version?: unknown;
    slice_state?: { schema_version?: unknown };
  } | null;
  try {
    decoded = JSON.parse(raw) as typeof decoded;
  } catch (err) {
    // A truncated or garbled file is a contract violation of the run
    // file itself, not an I/O failure — keep the typed error boundary.
    throw new TwolaneRunFileError(
      `${TWOLANE_RUN_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  // Version probes come first so ANY reader — including the branchless
  // run locator and the watch app, which do not pass through the
  // review-state gate — names the version of a pre-cut or foreign file
  // instead of surfacing a pile of shape issues.
  if (decoded?.schema_version !== TWOLANE_RUN_SCHEMA_VERSION)
    throw new TwolaneRunFileError(
      `run schema ${String(decoded?.schema_version)} is unsupported by current schema ${TWOLANE_RUN_SCHEMA_VERSION}`
    );
  if (decoded.slice_state?.schema_version !== SLICE_SCHEMA_VERSION)
    throw new TwolaneRunFileError(
      `slice schema ${String(decoded.slice_state?.schema_version)} is unsupported by current schema ${SLICE_SCHEMA_VERSION}`
    );
  const parsed = twolaneRunFileSchema.safeParse(decoded);
  if (!parsed.success)
    throw new TwolaneRunFileError(
      `${TWOLANE_RUN_FILE} violates the persisted run schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`
    );
  return parsed.data;
}
