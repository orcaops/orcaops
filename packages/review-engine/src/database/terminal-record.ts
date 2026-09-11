import { z } from 'zod';

import { executableIdentitySchema } from '@orcaops/review-core';

import {
  SEMANTIC_ANCHOR_RECEIPT_FILE,
  semanticAnchorInputReceiptSchema,
} from '../semanticAnchors.js';
import { STORY_REVIEW_MODEL_FILE } from '../storyReviewModel.js';
import {
  accountSubmissionLineageSchema,
  persistedExecutionProfileSchema,
  twolaneAttemptRecordSchema,
  type TwolaneRunFile,
} from '../twolaneRunFile.js';
import { aggregateIsolation, laneIsolation, latencyProfileFor } from '../twolaneRunMetadata.js';
import { decodeRetainedReviewJson, prepareReviewJson } from './records.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isolation = z.enum(['SUBAGENT_FRESH', 'SEQUENTIAL', 'UNKNOWN']);
const label = z.enum(['DERIVED', 'DEGRADED_ATTRIBUTION', 'CODE_ONLY']);
export const terminalOwnershipSchema = z
  .strictObject({
    label,
    reviewable_rows: count,
    attributed_rows: count,
    attributed_pct: z.number().min(0).max(100),
    ambiguous_rows: count,
    contested_rows: count,
    unattributed_rows: count,
    missing_boundary_checkpoints: count,
  })
  .superRefine((value, ctx) => {
    if (
      value.attributed_rows +
        value.ambiguous_rows +
        value.contested_rows +
        value.unattributed_rows !==
      value.reviewable_rows
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Ownership row partitions must equal the retained reviewable count',
      });
  });
export const terminalOutputsSchema = z.strictObject({
  review_md: z.literal('review.md'),
  brief_json: z.literal('brief.json'),
  composed_story: z.literal('composed-story-v2.json'),
  story_review_model: z.literal(STORY_REVIEW_MODEL_FILE),
  story_review_model_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ownership_label: label,
});
export const terminalRecordSchema = z
  .strictObject({
    schema_version: z.literal(1),
    run_id: z.string().min(1),
    branch: z.string(),
    mode: z.literal('routine'),
    created_at: z.iso.datetime(),
    finalized_at: z.iso.datetime(),
    elapsed_ms: count,
    latency_input_bytes: count,
    latency_tier: z.enum(['LT_250KB', 'FROM_250KB_TO_LT_1MB', 'FROM_1MB_TO_2MB']),
    latency_budget_ms: count,
    latency_status: z.enum(['PASS', 'MISSED']),
    runtime_identity: executableIdentitySchema.nullable(),
    execution_profile: persistedExecutionProfileSchema,
    outcome: z.enum(['FULL', 'DEGRADED', 'FAILED']),
    submission_count: count,
    repairs_used: count.max(2),
    repairs_by_lane: z.strictObject({ account: count.max(1), forensic: count.max(1) }),
    lane_inputs_served: z.strictObject({
      account: z.iso.datetime().optional(),
      forensic: z.iso.datetime().optional(),
    }),
    attempts: z.array(twolaneAttemptRecordSchema),
    isolation: z.strictObject({
      per_lane: z.strictObject({ account: isolation.nullable(), forensic: isolation.nullable() }),
      aggregate: isolation,
    }),
    usage: z.strictObject({
      status: z.enum(['HOST_REPORTED', 'UNKNOWN']),
      entries: z.array(
        z.strictObject({
          lane: z.enum(['account', 'forensic']),
          at: z.string(),
          tokens: z.number().nullable(),
          source: z.string().nullable(),
        })
      ),
    }),
    input_shas: z.record(z.string(), z.string()),
    range_validation: z.enum(['PERFORMED', 'SKIPPED_NO_PINNED_DIFF', 'NOT_APPLICABLE']),
    ownership_summary: terminalOwnershipSchema.nullable(),
    account_lineage: accountSubmissionLineageSchema.nullable(),
    outputs: terminalOutputsSchema.nullable(),
    semantic_anchor_input: semanticAnchorInputReceiptSchema.extend({
      receipt_file: z.literal(SEMANTIC_ANCHOR_RECEIPT_FILE).nullable(),
    }),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (value.submission_count !== value.attempts.length)
      issue('Submission count must match retained attempts');
    if (value.repairs_used !== value.repairs_by_lane.account + value.repairs_by_lane.forensic)
      issue('Repair count must match its lane counts');
    if (
      value.outcome === 'FAILED'
        ? value.outputs !== null ||
          value.ownership_summary !== null ||
          value.range_validation !== 'NOT_APPLICABLE'
        : value.outputs === null ||
          value.ownership_summary === null ||
          value.range_validation === 'NOT_APPLICABLE'
    )
      issue('Terminal outcome must match its retained output and range disclosures');
    if (value.outputs && value.outputs.ownership_label !== value.ownership_summary?.label)
      issue('Retained output and ownership labels must agree');
    if (value.semantic_anchor_input.run_id !== value.run_id)
      issue('Semantic preparation must retain the exact run identity');
  });
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export function prepareTerminalRecordBytes(input: {
  bytes: Uint8Array;
  secretAllow: readonly string[];
}) {
  return prepareReviewJson(terminalRecordSchema, input);
}
export function decodeRetainedTerminalRecord(bytes: Uint8Array) {
  return decodeRetainedReviewJson(terminalRecordSchema, bytes);
}
export function buildTerminalRecord(input: {
  run: TwolaneRunFile;
  finalizedAt: string;
  rangeValidation: TerminalRecord['range_validation'];
  ownershipSummary: TerminalRecord['ownership_summary'];
  outputs: TerminalRecord['outputs'];
  semanticInput: TerminalRecord['semantic_anchor_input'];
}): TerminalRecord {
  const run = input.run;
  const at = z.iso.datetime().parse(input.finalizedAt);
  const elapsedMs = Math.max(0, Date.parse(at) - Date.parse(run.created_at));
  const latency = latencyProfileFor(run.latency_input_bytes);
  const perLane = {
    account: laneIsolation(run.attempts, 'account'),
    forensic: laneIsolation(run.attempts, 'forensic'),
  };
  const usageEntries = run.attempts
    .filter((attempt) => attempt.usage_tokens !== null)
    .map((attempt) => ({
      lane: attempt.lane,
      at: attempt.at,
      tokens: attempt.usage_tokens,
      source: attempt.usage_source,
    }));
  const outcome =
    run.slice_state.lanes.account.accepted && run.slice_state.lanes.forensic.accepted
      ? 'FULL'
      : run.slice_state.lanes.account.accepted || run.slice_state.lanes.forensic.accepted
        ? 'DEGRADED'
        : 'FAILED';
  return terminalRecordSchema.parse({
    schema_version: 1,
    run_id: run.run_id,
    branch: run.branch,
    mode: run.mode,
    created_at: run.created_at,
    finalized_at: at,
    elapsed_ms: elapsedMs,
    ...latency,
    latency_status: elapsedMs <= latency.latency_budget_ms ? 'PASS' : 'MISSED',
    runtime_identity: run.runtime_identity,
    execution_profile: run.execution_profile,
    outcome,
    submission_count: run.attempts.length,
    repairs_used:
      2 - run.slice_state.lanes.account.repairCredit - run.slice_state.lanes.forensic.repairCredit,
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
    range_validation: input.rangeValidation,
    ownership_summary: input.ownershipSummary,
    account_lineage: run.account_lineage,
    outputs: input.outputs,
    semantic_anchor_input: input.semanticInput,
  });
}
