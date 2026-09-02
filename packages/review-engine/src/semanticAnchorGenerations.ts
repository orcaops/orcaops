// Pure semantic-anchor v3 submission validation and current-generation reading.
// Model proposals create associations only. They never mutate or adjudicate
// Story topology, checkpoint ownership, findings, or uncertainty state.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { executableIdentitySchema } from '@orcaops/review-core';

import {
  type AccountProjection,
  parseAccountProjectionJson,
  parseForensicInputJson,
} from './dossier.js';
import {
  collectEligibleSemanticAnchorCitations,
  ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS,
  parseSemanticAnchorInputReceipt,
  prepareSemanticAnchorInput,
  SEMANTIC_ANCHOR_RECEIPT_FILE,
  type SemanticAnchorCitation,
  semanticAnchorStoryCatalogIssue,
} from './semanticAnchors.js';
import type { CoverageInput } from './storyOwnership.js';
import { parseStoryReviewModel, STORY_REVIEW_MODEL_FILE } from './storyReviewModel.js';
import {
  canonicalJson,
  canonicalJsonSha256,
  normalizeSubmission,
  type SubmissionNormalizationCode,
} from './submissionNormalization.js';
import { readTwolaneRunFile, TwolaneRunFileError } from './twolaneRunFile.js';

export const SEMANTIC_ANCHOR_SUBMISSION_SCHEMA_VERSION = 3;
export const SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION = 3;
export const SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION = 3;
export const SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION = 3;
export const SEMANTIC_ANCHOR_MANIFEST_SCHEMA_VERSION = 3;
export const SEMANTIC_ANCHOR_POINTER_SCHEMA_VERSION = 3;
export const SEMANTIC_ANCHOR_MODEL_FILE = 'semantic-anchor-model-v3.json';
export const SEMANTIC_ANCHOR_MANIFEST_FILE = 'manifest-v3.json';
export const SEMANTIC_ANCHOR_CURRENT_FILE = 'current-v3.json';
export const SEMANTIC_ANCHOR_SOURCE = 'REVIEW_MODEL_SUBMISSION_COMPILED';
export const SEMANTIC_ANCHOR_ITEM_ORIGINS = [
  'REVIEW_MODEL_PROPOSED',
  'REVIEW_MODEL_REPORTED',
  'ENGINE_RECORDED_OMISSION',
] as const;
export const MAX_SEMANTIC_ANCHOR_TARGETS_PER_CITATION = 8;
export const SEMANTIC_ANCHOR_ATTEMPT_OUTCOMES = [
  'ACCEPTED_CLEAN_FIRST_PASS',
  'ACCEPTED_NORMALIZED_FIRST_PASS',
  'REJECTED_FIRST_PASS',
  'ACCEPTED_REPAIRED',
  'TERMINAL_REJECTED',
] as const;
export type SemanticAnchorAttemptOutcome = (typeof SEMANTIC_ANCHOR_ATTEMPT_OUTCOMES)[number];

const nonEmpty = z.string().min(1);
const sha256String = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const itemAlias = z.string().regex(/^i[1-9]\d*$/);
const blockAlias = z.string().regex(/^h[1-9]\d*\.b[1-9]\d*$/);
const endpointRef = z.string().regex(/^[DA][1-9]\d*$/);

const diagnosticSchema = z.strictObject({
  code: nonEmpty,
  path: z.string(),
  message: nonEmpty,
});

export interface SemanticAnchorDiagnostic {
  code: string;
  path: string;
  message: string;
}

const lineRangeSchema = z.strictObject({ start: endpointRef, end: endpointRef });

const proposedFocusSchema = z
  .strictObject({
    delete: lineRangeSchema.nullable(),
    add: lineRangeSchema.nullable(),
  })
  .superRefine((focus, ctx) => {
    if (focus.delete === null && focus.add === null)
      ctx.addIssue({
        code: 'custom',
        message: 'FOCUS requires at least one changed-row side',
      });
  });

const proposedTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    block: blockAlias,
    scope: z.literal('WHOLE_BLOCK'),
  }),
  z.strictObject({
    block: blockAlias,
    scope: z.literal('FOCUS'),
    focus: proposedFocusSchema,
  }),
]);
export type ProposedSemanticAnchorTarget = z.infer<typeof proposedTargetSchema>;

const anchoredDispositionSchema = z.strictObject({
  item: itemAlias,
  disposition: z.literal('ANCHORED'),
  targets: z.array(proposedTargetSchema).min(1).max(MAX_SEMANTIC_ANCHOR_TARGETS_PER_CITATION),
});
const unanchoredDispositionSchema = z.strictObject({
  item: itemAlias,
  disposition: z.literal('ASSESSED_UNANCHORED'),
  targets: z.array(z.never()).length(0),
});
const proposedDispositionSchema = z.discriminatedUnion('disposition', [
  anchoredDispositionSchema,
  unanchoredDispositionSchema,
]);

export const semanticAnchorSubmissionSchema = z.strictObject({
  schema_version: z.literal(SEMANTIC_ANCHOR_SUBMISSION_SCHEMA_VERSION),
  dispositions: z.array(proposedDispositionSchema),
});
export type SemanticAnchorSubmission = z.infer<typeof semanticAnchorSubmissionSchema>;

const catalogItemSchema = z.strictObject({
  alias: itemAlias,
  citation_id: nonEmpty,
  citation_kind: z.enum(ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS),
});

const catalogLineSchema = z.strictObject({
  ref: endpointRef,
  line: z.number().int().positive(),
  line_hash: sha256String,
});

const catalogBlockSchema = z.strictObject({
  alias: blockAlias,
  block_key: nonEmpty,
  hunk_alias: z.string().regex(/^h[1-9]\d*$/),
  hunk_key: nonEmpty,
  old_file: z.string().min(1).nullable(),
  new_file: z.string().min(1).nullable(),
  display_file: nonEmpty,
  delete: z.array(catalogLineSchema),
  add: z.array(catalogLineSchema),
});

export const semanticAnchorSubmissionCatalogSchema = z
  .strictObject({
    items: z.array(catalogItemSchema),
    blocks: z.array(catalogBlockSchema),
  })
  .superRefine((catalog, ctx) => {
    for (const [path, values] of [
      ['items.alias', catalog.items.map((item) => item.alias)],
      ['items.citation_id', catalog.items.map((item) => item.citation_id)],
      ['blocks.alias', catalog.blocks.map((block) => block.alias)],
      ['blocks.block_key', catalog.blocks.map((block) => block.block_key)],
    ] as const) {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: 'custom', path: path.split('.'), message: `${path} must be unique` });
    }
    for (const [blockIndex, block] of catalog.blocks.entries()) {
      if (block.old_file === null && block.new_file === null)
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', blockIndex],
          message: 'a block requires an old or new file identity',
        });
      for (const [side, rows] of [
        ['delete', block.delete],
        ['add', block.add],
      ] as const) {
        if (new Set(rows.map((row) => row.line)).size !== rows.length)
          ctx.addIssue({
            code: 'custom',
            path: ['blocks', blockIndex, side],
            message: `${side} line numbers must be unique within a block`,
          });
        const prefix = side === 'delete' ? 'D' : 'A';
        for (const [rowIndex, row] of rows.entries()) {
          if (row.ref !== `${prefix}${rowIndex + 1}`)
            ctx.addIssue({
              code: 'custom',
              path: ['blocks', blockIndex, side, rowIndex, 'ref'],
              message: `${side} refs must be contiguous and block-local from ${prefix}1`,
            });
        }
      }
    }
  });
export type SemanticAnchorSubmissionCatalog = z.infer<typeof semanticAnchorSubmissionCatalogSchema>;

const durableRangeSchema = z.strictObject({
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  line_hashes: z.array(sha256String).min(1),
});

const durableBlockSchema = z.strictObject({
  block_key: nonEmpty,
  hunk_key: nonEmpty,
  old_file: z.string().min(1).nullable(),
  new_file: z.string().min(1).nullable(),
  display_file: nonEmpty,
  delete: durableRangeSchema.nullable(),
  add: durableRangeSchema.nullable(),
});
export type DurableSemanticAnchorBlock = z.infer<typeof durableBlockSchema>;

const resolvedFocusSchema = z.strictObject({
  delete: durableRangeSchema.nullable(),
  add: durableRangeSchema.nullable(),
});

export const semanticAnchorResolvedTargetSchema = z
  .strictObject({
    schema_version: z.literal(SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION),
    block: durableBlockSchema,
    scope: z.enum(['WHOLE_BLOCK', 'FOCUS']),
    focus: resolvedFocusSchema.nullable(),
    focus_status: z.enum(['NONE', 'ACCEPTED', 'REJECTED_INVALID']),
    focus_diagnostic_code: z
      .enum([
        'FOCUS_UNKNOWN_ENDPOINT',
        'FOCUS_EXCEEDS_BLOCK',
        'FOCUS_SIDE_NOT_IN_BLOCK',
        'FOCUS_RANGE_INVALID',
      ])
      .nullable(),
    warnings: z.array(diagnosticSchema),
  })
  .superRefine((target, ctx) => {
    if (target.scope === 'WHOLE_BLOCK' && target.focus_status !== 'NONE')
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'WHOLE_BLOCK requires NONE focus status',
      });
    if (target.scope === 'FOCUS' && target.focus_status === 'NONE')
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'FOCUS requires an accepted or visibly rejected focus result',
      });
    if (
      target.focus_status === 'NONE' &&
      (target.focus !== null || target.focus_diagnostic_code !== null)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['focus_status'],
        message: 'NONE cannot retain focus or a diagnostic code',
      });
    if (
      target.focus_status === 'ACCEPTED' &&
      (target.focus === null || target.focus_diagnostic_code !== null)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['focus_status'],
        message: 'ACCEPTED requires focus without a diagnostic code',
      });
    if (
      target.focus_status === 'REJECTED_INVALID' &&
      (target.focus !== null || target.focus_diagnostic_code === null)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['focus_status'],
        message: 'REJECTED_INVALID requires a diagnostic code and no focus',
      });
  });
export type SemanticAnchorResolvedTarget = z.infer<typeof semanticAnchorResolvedTargetSchema>;

const semanticAnchorModelItemSchema = z.discriminatedUnion('disposition', [
  z.strictObject({
    citation_id: nonEmpty,
    citation_kind: z.enum(ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS),
    disposition: z.literal('ANCHORED'),
    origin: z.literal('REVIEW_MODEL_PROPOSED'),
    targets: z
      .array(semanticAnchorResolvedTargetSchema)
      .min(1)
      .max(MAX_SEMANTIC_ANCHOR_TARGETS_PER_CITATION),
  }),
  z.strictObject({
    citation_id: nonEmpty,
    citation_kind: z.enum(ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS),
    disposition: z.literal('ASSESSED_UNANCHORED'),
    origin: z.literal('REVIEW_MODEL_REPORTED'),
    targets: z.array(z.never()).length(0),
  }),
  z.strictObject({
    citation_id: nonEmpty,
    citation_kind: z.enum(ELIGIBLE_SEMANTIC_ANCHOR_CITATION_KINDS),
    disposition: z.literal('NO_ANCHOR_PROPOSED'),
    origin: z.literal('ENGINE_RECORDED_OMISSION'),
    targets: z.array(z.never()).length(0),
  }),
]);

export const semanticAnchorModelSchema = z
  .strictObject({
    schema_version: z.literal(SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION),
    generation_id: uuid,
    run_id: uuid,
    floor_input_hash: nonEmpty,
    prepared_payload_sha256: sha256String,
    source: z.literal(SEMANTIC_ANCHOR_SOURCE),
    items: z.array(semanticAnchorModelItemSchema),
  })
  .superRefine((model, ctx) => {
    const ids = model.items.map((item) => item.citation_id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'installed citation identities must be unique',
      });
  });
export type SemanticAnchorModel = z.infer<typeof semanticAnchorModelSchema>;

const sourceHashesSchema = z.strictObject({
  story_review_model_sha256: sha256String,
  account_projection_sha256: sha256String,
  coverage_sha256: sha256String,
  diff_sha256: sha256String,
  accepted_account_envelope_sha256: sha256String,
  compiled_account_payload_sha256: sha256String,
});
export type SemanticAnchorSourceHashes = z.infer<typeof sourceHashesSchema>;

export const semanticAnchorAttemptSchema = z
  .strictObject({
    schema_version: z.literal(SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION),
    generation_id: uuid,
    run_id: uuid,
    attempt: z.union([z.literal(1), z.literal(2)]),
    started_at: z.iso.datetime(),
    submitted_at: z.iso.datetime(),
    elapsed_ms: z.number().int().nonnegative(),
    runtime_identity: executableIdentitySchema.nullable(),
    declared_profile: nonEmpty,
    profile_source: z.literal('CALLER_DECLARED'),
    normalization: z.enum(['CLEAN_JSON', 'JSON_STRING_UNWRAPPED', 'INVALID_JSON']),
    raw_submission_sha256: sha256String,
    normalized_submission_sha256: sha256String,
    normalized_submission: z.record(z.string(), z.unknown()).nullable(),
    accepted: z.boolean(),
    outcome: z.enum(SEMANTIC_ANCHOR_ATTEMPT_OUTCOMES),
    has_focus_warnings: z.boolean(),
    diagnostics: z.array(diagnosticSchema),
    warnings: z.array(diagnosticSchema),
  })
  .superRefine((attempt, ctx) => {
    if (Date.parse(attempt.submitted_at) - Date.parse(attempt.started_at) !== attempt.elapsed_ms)
      ctx.addIssue({
        code: 'custom',
        path: ['elapsed_ms'],
        message: 'attempt elapsed time must match its recorded timestamps',
      });
    if (attempt.accepted && attempt.normalized_submission === null)
      ctx.addIssue({
        code: 'custom',
        path: ['normalized_submission'],
        message: 'an accepted attempt requires its canonical normalized submission object',
      });
    if (
      attempt.normalized_submission !== null &&
      canonicalJsonSha256(attempt.normalized_submission) !== attempt.normalized_submission_sha256
    )
      ctx.addIssue({
        code: 'custom',
        path: ['normalized_submission_sha256'],
        message: 'normalized submission hash must match its canonical object',
      });
    if (
      attempt.has_focus_warnings !==
      attempt.warnings.some((warning) => warning.code.startsWith('FOCUS_'))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['has_focus_warnings'],
        message: 'focus-warning flag must match structured focus warnings',
      });
  });
export type SemanticAnchorAttempt = z.infer<typeof semanticAnchorAttemptSchema>;

export const semanticAnchorManifestSchema = z
  .strictObject({
    schema_version: z.literal(SEMANTIC_ANCHOR_MANIFEST_SCHEMA_VERSION),
    generation_id: uuid,
    run_id: uuid,
    status: z.enum(['VALID', 'REJECTED']),
    created_at: z.iso.datetime(),
    lifecycle_started_at: z.iso.datetime(),
    lifecycle_elapsed_ms: z.number().int().nonnegative(),
    runtime_identity: executableIdentitySchema.nullable(),
    attempt_count: z.number().int().min(1).max(2),
    declared_profile: nonEmpty,
    profile_source: z.literal('CALLER_DECLARED'),
    source: z.literal(SEMANTIC_ANCHOR_SOURCE),
    prepared_input_schema_version: z.literal(4),
    submission_schema_version: z.literal(SEMANTIC_ANCHOR_SUBMISSION_SCHEMA_VERSION),
    attempt_schema_version: z.literal(SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION),
    target_schema_version: z.literal(SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION),
    model_schema_version: z.literal(SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION),
    model_file: z.literal(SEMANTIC_ANCHOR_MODEL_FILE),
    source_hashes: sourceHashesSchema,
    prepared_receipt_sha256: sha256String,
    prepared_payload_sha256: sha256String,
    attempt_sha256s: z.array(sha256String).min(1).max(2),
    accepted_attempt_sha256: sha256String.nullable(),
    model_sha256: sha256String.nullable(),
    diagnostic_codes: z.array(nonEmpty),
    warning_codes: z.array(nonEmpty),
    final_attempt_outcome: z.enum(SEMANTIC_ANCHOR_ATTEMPT_OUTCOMES),
  })
  .superRefine((manifest, ctx) => {
    if (
      Date.parse(manifest.created_at) - Date.parse(manifest.lifecycle_started_at) !==
      manifest.lifecycle_elapsed_ms
    )
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle_elapsed_ms'],
        message: 'generation elapsed time must match its recorded timestamps',
      });
    if (manifest.attempt_sha256s.length !== manifest.attempt_count)
      ctx.addIssue({
        code: 'custom',
        path: ['attempt_sha256s'],
        message: 'attempt hashes must cover every immutable attempt',
      });
    if (manifest.status === 'VALID') {
      if (!manifest.final_attempt_outcome.startsWith('ACCEPTED_'))
        ctx.addIssue({
          code: 'custom',
          path: ['final_attempt_outcome'],
          message: 'VALID requires an accepted final-attempt outcome',
        });
      if (manifest.model_sha256 === null)
        ctx.addIssue({
          code: 'custom',
          path: ['model_sha256'],
          message: 'VALID requires a model hash',
        });
      if (manifest.accepted_attempt_sha256 === null)
        ctx.addIssue({
          code: 'custom',
          path: ['accepted_attempt_sha256'],
          message: 'VALID requires an accepted attempt hash',
        });
      else if (!manifest.attempt_sha256s.includes(manifest.accepted_attempt_sha256))
        ctx.addIssue({
          code: 'custom',
          path: ['accepted_attempt_sha256'],
          message: 'accepted attempt must belong to this generation',
        });
    } else {
      if (manifest.model_sha256 !== null || manifest.accepted_attempt_sha256 !== null)
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'REJECTED cannot reference a model or accepted attempt',
        });
      if (manifest.final_attempt_outcome !== 'TERMINAL_REJECTED')
        ctx.addIssue({
          code: 'custom',
          path: ['final_attempt_outcome'],
          message: 'REJECTED requires TERMINAL_REJECTED',
        });
    }
  });
export type SemanticAnchorManifest = z.infer<typeof semanticAnchorManifestSchema>;

export const semanticAnchorCurrentPointerSchema = z.strictObject({
  schema_version: z.literal(SEMANTIC_ANCHOR_POINTER_SCHEMA_VERSION),
  run_id: uuid,
  generation_id: uuid,
  manifest_file: z.literal(SEMANTIC_ANCHOR_MANIFEST_FILE),
  manifest_sha256: sha256String,
});
export type SemanticAnchorCurrentPointer = z.infer<typeof semanticAnchorCurrentPointerSchema>;

export type SemanticAnchorValidationResult =
  | {
      accepted: true;
      model: SemanticAnchorModel;
      diagnostics: [];
      warnings: SemanticAnchorDiagnostic[];
    }
  | {
      accepted: false;
      model: null;
      diagnostics: SemanticAnchorDiagnostic[];
      warnings: [];
    };

export interface NormalizedSemanticAnchorSubmission {
  raw_sha256: string;
  normalized_sha256: string;
  normalization: SubmissionNormalizationCode;
  normalized: unknown;
  canonical: Record<string, unknown> | null;
}

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

/** Parse raw JSON and, only when it is a JSON string, one additional JSON object layer. */
export function normalizeSemanticAnchorSubmission(
  rawText: string
): NormalizedSemanticAnchorSubmission {
  const normalized = normalizeSubmission(rawText);
  const canonical =
    normalized.value !== null &&
    typeof normalized.value === 'object' &&
    !Array.isArray(normalized.value)
      ? (JSON.parse(canonicalJson(normalized.value)) as Record<string, unknown>)
      : null;
  return {
    raw_sha256: normalized.raw_sha256,
    normalized_sha256: normalized.normalized_sha256,
    normalization: normalized.code,
    normalized: normalized.value,
    canonical,
  };
}

function zodDiagnostics(error: z.ZodError): SemanticAnchorDiagnostic[] {
  return error.issues.map((issue) => ({
    code: 'SEMANTIC_ANCHOR_SUBMISSION_SHAPE',
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function durableRange(
  rows: SemanticAnchorSubmissionCatalog['blocks'][number]['add']
): z.infer<typeof durableRangeSchema> | null {
  if (rows.length === 0) return null;
  return {
    start_line: rows[0]!.line,
    end_line: rows[rows.length - 1]!.line,
    line_hashes: rows.map((row) => row.line_hash),
  };
}

function durableBlock(
  block: SemanticAnchorSubmissionCatalog['blocks'][number]
): DurableSemanticAnchorBlock {
  return durableBlockSchema.parse({
    block_key: block.block_key,
    hunk_key: block.hunk_key,
    old_file: block.old_file,
    new_file: block.new_file,
    display_file: block.display_file,
    delete: durableRange(block.delete),
    add: durableRange(block.add),
  });
}

type FocusDiagnosticCode = NonNullable<SemanticAnchorResolvedTarget['focus_diagnostic_code']>;

class FocusResolutionError extends Error {
  constructor(
    readonly code: FocusDiagnosticCode,
    message: string
  ) {
    super(message);
  }
}

function resolveFocusSide(
  block: SemanticAnchorSubmissionCatalog['blocks'][number],
  side: 'delete' | 'add',
  proposed: z.infer<typeof lineRangeSchema>
): z.infer<typeof durableRangeSchema> {
  const expectedPrefix = side === 'delete' ? 'D' : 'A';
  const rows = block[side];
  if (rows.length === 0)
    throw new FocusResolutionError(
      'FOCUS_SIDE_NOT_IN_BLOCK',
      `${side} focus is not available in selected block ${block.alias}`
    );
  if (!proposed.start.startsWith(expectedPrefix) || !proposed.end.startsWith(expectedPrefix))
    throw new FocusResolutionError(
      'FOCUS_RANGE_INVALID',
      `${proposed.start}-${proposed.end} mixes endpoint sides for ${side} focus`
    );
  const startOrdinal = Number(proposed.start.slice(1));
  const endOrdinal = Number(proposed.end.slice(1));
  if (startOrdinal > rows.length || endOrdinal > rows.length)
    throw new FocusResolutionError(
      'FOCUS_EXCEEDS_BLOCK',
      `${proposed.start}-${proposed.end} exceeds the ${side} extent of ${block.alias}`
    );
  if (endOrdinal < startOrdinal)
    throw new FocusResolutionError(
      'FOCUS_RANGE_INVALID',
      `${proposed.start}-${proposed.end} is reversed within selected block ${block.alias}`
    );
  const start = rows.findIndex((row) => row.ref === proposed.start);
  const end = rows.findIndex((row) => row.ref === proposed.end);
  if (start < 0 || end < 0)
    throw new FocusResolutionError(
      'FOCUS_UNKNOWN_ENDPOINT',
      `${proposed.start}-${proposed.end} cannot be resolved in selected block ${block.alias}`
    );
  const selected = rows.slice(start, end + 1);
  return durableRangeSchema.parse({
    start_line: selected[0]!.line,
    end_line: selected[selected.length - 1]!.line,
    line_hashes: selected.map((row) => row.line_hash),
  });
}

function resolveTargetFocus(
  block: SemanticAnchorSubmissionCatalog['blocks'][number],
  proposed: ProposedSemanticAnchorTarget,
  pathPrefix: string
): {
  focus: z.infer<typeof resolvedFocusSchema> | null;
  focus_status: SemanticAnchorResolvedTarget['focus_status'];
  focus_diagnostic_code: SemanticAnchorResolvedTarget['focus_diagnostic_code'];
  warnings: SemanticAnchorDiagnostic[];
} {
  if (proposed.scope === 'WHOLE_BLOCK')
    return {
      focus: null,
      focus_status: 'NONE',
      focus_diagnostic_code: null,
      warnings: [],
    };
  try {
    const focus = resolvedFocusSchema.parse({
      delete:
        proposed.focus.delete === null
          ? null
          : resolveFocusSide(block, 'delete', proposed.focus.delete),
      add: proposed.focus.add === null ? null : resolveFocusSide(block, 'add', proposed.focus.add),
    });
    return {
      focus,
      focus_status: 'ACCEPTED',
      focus_diagnostic_code: null,
      warnings: [],
    };
  } catch (error) {
    const code =
      error instanceof FocusResolutionError ? error.code : ('FOCUS_RANGE_INVALID' as const);
    return {
      focus: null,
      focus_status: 'REJECTED_INVALID',
      focus_diagnostic_code: code,
      warnings: [
        {
          code,
          path: `${pathPrefix}.focus`,
          message: `block ${block.alias} remains associated but its submitted FOCUS was rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }
}

function validateCatalogAgainstProjection(
  projection: AccountProjection,
  catalog: SemanticAnchorSubmissionCatalog
): SemanticAnchorDiagnostic[] {
  const eligible = collectEligibleSemanticAnchorCitations(projection);
  const eligibleById = new Map(eligible.map((citation) => [citation.id, citation.kind]));
  const diagnostics: SemanticAnchorDiagnostic[] = [];
  for (const [index, item] of catalog.items.entries()) {
    if (eligibleById.get(item.citation_id) !== item.citation_kind)
      diagnostics.push({
        code: 'SEMANTIC_ANCHOR_CATALOG_MISMATCH',
        path: `catalog.items.${index}`,
        message: `${item.alias} does not match an eligible account item`,
      });
  }
  for (const citation of eligible) {
    if (!catalog.items.some((item) => item.citation_id === citation.id))
      diagnostics.push({
        code: 'SEMANTIC_ANCHOR_CATALOG_MISMATCH',
        path: 'catalog.items',
        message: `${citation.id} has no deterministic item alias`,
      });
  }
  return diagnostics;
}

/** Validate sparse authored dispositions and compile a complete, exact-once installed model. */
export function validateSemanticAnchorSubmission(input: {
  raw: unknown;
  generationId: string;
  runId: string;
  floorInputHash: string;
  preparedPayloadSha256: string;
  projection: AccountProjection;
  catalog: SemanticAnchorSubmissionCatalog;
}): SemanticAnchorValidationResult {
  const catalog = semanticAnchorSubmissionCatalogSchema.safeParse(input.catalog);
  if (!catalog.success)
    return {
      accepted: false,
      model: null,
      diagnostics: catalog.error.issues.map((issue) => ({
        code: 'SEMANTIC_ANCHOR_CATALOG_INVALID',
        path: issue.path.join('.'),
        message: issue.message,
      })),
      warnings: [],
    };
  const catalogDiagnostics = validateCatalogAgainstProjection(input.projection, catalog.data);
  if (catalogDiagnostics.length > 0)
    return { accepted: false, model: null, diagnostics: catalogDiagnostics, warnings: [] };

  const parsed = semanticAnchorSubmissionSchema.safeParse(input.raw);
  if (!parsed.success)
    return {
      accepted: false,
      model: null,
      diagnostics: zodDiagnostics(parsed.error),
      warnings: [],
    };

  const itemByAlias = new Map(catalog.data.items.map((item) => [item.alias, item]));
  const blockByAlias = new Map(catalog.data.blocks.map((block) => [block.alias, block]));
  const proposedByAlias = new Map<string, (typeof parsed.data.dispositions)[number]>();
  const diagnostics: SemanticAnchorDiagnostic[] = [];
  for (const [index, disposition] of parsed.data.dispositions.entries()) {
    if (!itemByAlias.has(disposition.item)) {
      diagnostics.push({
        code: 'SEMANTIC_ANCHOR_UNKNOWN_ITEM',
        path: `dispositions.${index}.item`,
        message: `${disposition.item} is not an item alias in prepared input v4`,
      });
      continue;
    }
    if (proposedByAlias.has(disposition.item)) {
      diagnostics.push({
        code: 'SEMANTIC_ANCHOR_DUPLICATE_DISPOSITION',
        path: `dispositions.${index}.item`,
        message: `${disposition.item} appears more than once`,
      });
      continue;
    }
    proposedByAlias.set(disposition.item, disposition);
  }
  if (diagnostics.length > 0) return { accepted: false, model: null, diagnostics, warnings: [] };

  const items: SemanticAnchorModel['items'] = [];
  const warnings: SemanticAnchorDiagnostic[] = [];
  for (const itemAliasValue of catalog.data.items) {
    const disposition = proposedByAlias.get(itemAliasValue.alias);
    if (disposition === undefined) {
      items.push({
        citation_id: itemAliasValue.citation_id,
        citation_kind: itemAliasValue.citation_kind,
        disposition: 'NO_ANCHOR_PROPOSED',
        origin: 'ENGINE_RECORDED_OMISSION',
        targets: [],
      });
      continue;
    }
    if (disposition.disposition === 'ASSESSED_UNANCHORED') {
      items.push({
        citation_id: itemAliasValue.citation_id,
        citation_kind: itemAliasValue.citation_kind,
        disposition: 'ASSESSED_UNANCHORED',
        origin: 'REVIEW_MODEL_REPORTED',
        targets: [],
      });
      continue;
    }
    const targets: SemanticAnchorResolvedTarget[] = [];
    const seenBlockKeys = new Set<string>();
    const dispositionIndex = parsed.data.dispositions.indexOf(disposition);
    for (const [targetIndex, proposed] of disposition.targets.entries()) {
      const targetPath = `dispositions.${dispositionIndex}.targets.${targetIndex}`;
      const block = blockByAlias.get(proposed.block);
      if (block === undefined) {
        diagnostics.push({
          code: 'SEMANTIC_ANCHOR_UNKNOWN_BLOCK',
          path: `${targetPath}.block`,
          message: `${proposed.block} is not a block alias in prepared input v4`,
        });
        continue;
      }
      if (seenBlockKeys.has(block.block_key)) {
        diagnostics.push({
          code: 'SEMANTIC_ANCHOR_DUPLICATE_TARGET',
          path: targetPath,
          message: `${itemAliasValue.alias} selects block ${proposed.block} more than once`,
        });
        continue;
      }
      seenBlockKeys.add(block.block_key);
      const resolvedFocus = resolveTargetFocus(block, proposed, targetPath);
      warnings.push(...resolvedFocus.warnings);
      targets.push(
        semanticAnchorResolvedTargetSchema.parse({
          schema_version: SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION,
          block: durableBlock(block),
          scope: proposed.scope,
          focus: resolvedFocus.focus,
          focus_status: resolvedFocus.focus_status,
          focus_diagnostic_code: resolvedFocus.focus_diagnostic_code,
          warnings: resolvedFocus.warnings,
        })
      );
    }
    items.push({
      citation_id: itemAliasValue.citation_id,
      citation_kind: itemAliasValue.citation_kind,
      disposition: 'ANCHORED',
      origin: 'REVIEW_MODEL_PROPOSED',
      targets,
    });
  }
  if (diagnostics.length > 0) return { accepted: false, model: null, diagnostics, warnings: [] };
  return {
    accepted: true,
    diagnostics: [],
    warnings,
    model: semanticAnchorModelSchema.parse({
      schema_version: SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION,
      generation_id: input.generationId,
      run_id: input.runId,
      floor_input_hash: input.floorInputHash,
      prepared_payload_sha256: input.preparedPayloadSha256,
      source: SEMANTIC_ANCHOR_SOURCE,
      items,
    }),
  };
}

const attemptFile = (dir: string, attempt: number): string =>
  path.join(dir, `attempt-${attempt}-v3.json`);

async function validateGenerationAgainstFinalizedRun(
  runDir: string,
  pointer: SemanticAnchorCurrentPointer,
  manifest: SemanticAnchorManifest,
  model: SemanticAnchorModel
): Promise<string | null> {
  try {
    // The strict persisted-schema read: a corrupt run file throws
    // TwolaneRunFileError, which the catch below names distinctly from
    // a missing file.
    const [run, recordRaw] = await Promise.all([
      readTwolaneRunFile(runDir),
      readFile(path.join(runDir, 'run-record-v1.json'), 'utf8'),
    ]);
    const record = JSON.parse(recordRaw) as Record<string, unknown>;
    if (
      run.finalized === null ||
      run.run_id !== pointer.run_id ||
      record.run_id !== pointer.run_id ||
      record.outcome !== run.finalized.outcome ||
      record.finalized_at !== run.finalized.at ||
      JSON.stringify(record.input_shas) !== JSON.stringify(run.input_shas)
    )
      return 'current generation does not match a terminal finalized run record';
    const preparedRecord = record.semantic_anchor_input;
    if (preparedRecord === null || typeof preparedRecord !== 'object')
      return 'current generation has no finalized prepared-input receipt';
    const { receipt_file: receiptFile, ...receiptFields } = preparedRecord as Record<
      string,
      unknown
    >;
    const receipt = parseSemanticAnchorInputReceipt(receiptFields);
    if (
      receipt.status !== 'READY' ||
      receipt.payload_file === null ||
      receipt.payload_sha256 === null ||
      manifest.prepared_payload_sha256 !== receipt.payload_sha256 ||
      JSON.stringify(manifest.source_hashes) !== JSON.stringify(receipt.source_hashes)
    )
      return 'current generation does not match the finalized prepared-input receipt';
    if (receiptFile !== SEMANTIC_ANCHOR_RECEIPT_FILE)
      return 'current generation prepared-input receipt file is absent';
    const receiptRaw = await readFile(path.join(runDir, receiptFile), 'utf8');
    if (sha256(receiptRaw) !== manifest.prepared_receipt_sha256)
      return 'current generation prepared-input receipt hash is stale';
    const receiptDisk = parseSemanticAnchorInputReceipt(JSON.parse(receiptRaw));
    if (JSON.stringify(receiptDisk) !== JSON.stringify(receipt))
      return 'current generation prepared-input receipt differs from the run record';
    const accountLineage = record.account_lineage as
      | {
          accepted_envelope_sha256?: unknown;
          compiled_payload_sha256?: unknown;
        }
      | null
      | undefined;
    if (
      accountLineage === null ||
      accountLineage === undefined ||
      typeof accountLineage.accepted_envelope_sha256 !== 'string' ||
      typeof accountLineage.compiled_payload_sha256 !== 'string'
    )
      return 'current generation has no finalized accepted-account lineage';
    const [story, projection, coverage, diff, forensicInput, payload, acceptedAccountRaw] =
      await Promise.all([
        readFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), 'utf8'),
        readFile(path.join(runDir, 'account-projection-v1.json'), 'utf8'),
        readFile(path.join(runDir, 'coverage-v1.json'), 'utf8'),
        readFile(path.join(runDir, 'diff.patch'), 'utf8'),
        readFile(path.join(runDir, 'forensic-input-v1.json'), 'utf8'),
        readFile(path.join(runDir, receipt.payload_file), 'utf8'),
        readFile(path.join(runDir, 'accepted-account.json'), 'utf8'),
      ]);
    const acceptedAccount = JSON.parse(acceptedAccountRaw) as { compiled_payload?: unknown };
    if (
      sha256(story) !== manifest.source_hashes.story_review_model_sha256 ||
      sha256(projection) !== manifest.source_hashes.account_projection_sha256 ||
      sha256(coverage) !== manifest.source_hashes.coverage_sha256 ||
      sha256(diff) !== manifest.source_hashes.diff_sha256 ||
      canonicalJsonSha256(acceptedAccount) !==
        manifest.source_hashes.accepted_account_envelope_sha256 ||
      canonicalJsonSha256(acceptedAccount.compiled_payload) !==
        manifest.source_hashes.compiled_account_payload_sha256 ||
      accountLineage.accepted_envelope_sha256 !==
        manifest.source_hashes.accepted_account_envelope_sha256 ||
      accountLineage.compiled_payload_sha256 !==
        manifest.source_hashes.compiled_account_payload_sha256 ||
      sha256(payload) !== manifest.prepared_payload_sha256 ||
      Buffer.byteLength(payload) !== receipt.payload_bytes
    )
      return 'current generation source or prepared-payload hash is stale';
    const storyModel = parseStoryReviewModel(JSON.parse(story));
    const rerendered = prepareSemanticAnchorInput({
      runId: pointer.run_id,
      storyModel,
      storyModelBytes: story,
      accountProjection: parseAccountProjectionJson(
        projection,
        `${runDir}/account-projection-v1.json`
      ),
      accountProjectionBytes: projection,
      coverage: JSON.parse(coverage) as CoverageInput,
      coverageBytes: coverage,
      pinnedDiffText: diff,
      forensicInput: parseForensicInputJson(forensicInput, `${runDir}/forensic-input-v1.json`),
      forensicInputBytes: forensicInput,
      accountLineage: {
        acceptedEnvelopeSha256: accountLineage.accepted_envelope_sha256,
        compiledPayloadSha256: accountLineage.compiled_payload_sha256,
      },
    });
    if (
      rerendered.receipt.status !== 'READY' ||
      rerendered.receipt.payload_sha256 !== receipt.payload_sha256 ||
      JSON.stringify(rerendered.receipt.source_hashes) !== JSON.stringify(receipt.source_hashes) ||
      JSON.stringify(rerendered.receipt.derivation_hashes) !==
        JSON.stringify(receipt.derivation_hashes) ||
      JSON.stringify(rerendered.receipt.target_scope) !== JSON.stringify(receipt.target_scope)
    )
      return 'current generation prepared input is stale against immutable policy inputs';
    const catalogIssue = semanticAnchorStoryCatalogIssue(storyModel, rerendered.items);
    if (catalogIssue !== null) return `current generation ${catalogIssue}`;
    const expectedItems = rerendered.items.map((item) => ({ id: item.id, kind: item.kind }));
    const installedItems = model.items.map((item) => ({
      id: item.citation_id,
      kind: item.citation_kind,
    }));
    if (JSON.stringify(installedItems) !== JSON.stringify(expectedItems))
      return 'current generation does not contain every eligible item exactly once in source order';
    return null;
  } catch (error) {
    // Distinguish the three failure families instead of flattening them:
    // a typed run-file violation names the contract, a missing file names
    // the absence, and anything else stays a generic invalid-contract
    // disposition.
    if (error instanceof TwolaneRunFileError) {
      return `current generation run file violates the persisted contract: ${error.message}`;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return `current generation is missing a required run file: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return `current generation finalized-run contract is invalid: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export type CurrentSemanticAnchorGeneration =
  | { status: 'ABSENT' }
  | { status: 'STALE'; reason: string }
  | { status: 'INVALID'; reason: string }
  | {
      status: 'OK';
      pointer: SemanticAnchorCurrentPointer;
      manifest: SemanticAnchorManifest;
      model: SemanticAnchorModel;
    };

/** Read exactly the v3 pointed generation. */
export async function loadCurrentSemanticAnchorGeneration(
  runDir: string
): Promise<CurrentSemanticAnchorGeneration> {
  const anchors = path.join(runDir, 'anchors');
  const pointerPath = path.join(anchors, SEMANTIC_ANCHOR_CURRENT_FILE);
  let pointerRaw: string;
  try {
    pointerRaw = await readFile(pointerPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'ABSENT' };
    return { status: 'INVALID', reason: `current pointer is unreadable: ${String(error)}` };
  }
  let pointerJson: unknown;
  try {
    pointerJson = JSON.parse(pointerRaw);
  } catch {
    return { status: 'INVALID', reason: 'current pointer is not valid JSON' };
  }
  const pointer = semanticAnchorCurrentPointerSchema.safeParse(pointerJson);
  if (!pointer.success) return { status: 'INVALID', reason: 'current pointer schema is invalid' };
  const generationDir = path.join(anchors, 'generations', pointer.data.generation_id);
  try {
    const manifestRaw = await readFile(
      path.join(generationDir, pointer.data.manifest_file),
      'utf8'
    );
    if (sha256(manifestRaw) !== pointer.data.manifest_sha256)
      return { status: 'INVALID', reason: 'current manifest hash does not match the pointer' };
    const manifestJson = JSON.parse(manifestRaw) as unknown;
    const manifest = semanticAnchorManifestSchema.parse(manifestJson);
    if (
      manifest.status !== 'VALID' ||
      manifest.generation_id !== pointer.data.generation_id ||
      manifest.run_id !== pointer.data.run_id ||
      manifest.model_sha256 === null ||
      manifest.accepted_attempt_sha256 === null
    )
      return {
        status: 'INVALID',
        reason: 'current manifest identity or terminal status is invalid',
      };
    const acceptedAttemptHashes: string[] = [];
    let firstAttemptStartedAt: string | null = null;
    let finalAttemptOutcome: SemanticAnchorAttemptOutcome | null = null;
    let finalRuntimeIdentity: unknown = null;
    for (let index = 0; index < manifest.attempt_count; index += 1) {
      const attemptRaw = await readFile(attemptFile(generationDir, index + 1), 'utf8');
      const attemptSha = sha256(attemptRaw);
      if (attemptSha !== manifest.attempt_sha256s[index])
        return { status: 'INVALID', reason: 'current attempt hash does not match its manifest' };
      const attempt = semanticAnchorAttemptSchema.parse(JSON.parse(attemptRaw));
      if (
        attempt.generation_id !== manifest.generation_id ||
        attempt.run_id !== manifest.run_id ||
        attempt.attempt !== index + 1
      )
        return { status: 'INVALID', reason: 'current attempt identity is invalid' };
      if (
        (attempt.normalized_submission !== null &&
          canonicalJsonSha256(attempt.normalized_submission) !==
            attempt.normalized_submission_sha256) ||
        (attempt.accepted && attempt.normalized_submission === null)
      )
        return { status: 'INVALID', reason: 'current attempt normalized lineage is invalid' };
      if (attempt.accepted) acceptedAttemptHashes.push(attemptSha);
      firstAttemptStartedAt ??= attempt.started_at;
      finalAttemptOutcome = attempt.outcome;
      finalRuntimeIdentity = attempt.runtime_identity;
    }
    if (
      manifest.lifecycle_started_at !== firstAttemptStartedAt ||
      manifest.final_attempt_outcome !== finalAttemptOutcome ||
      JSON.stringify(manifest.runtime_identity) !== JSON.stringify(finalRuntimeIdentity)
    )
      return { status: 'INVALID', reason: 'current generation attempt lifecycle is invalid' };
    if (
      acceptedAttemptHashes.length !== 1 ||
      acceptedAttemptHashes[0] !== manifest.accepted_attempt_sha256
    )
      return { status: 'INVALID', reason: 'current accepted-attempt lineage is invalid' };
    const modelRaw = await readFile(path.join(generationDir, manifest.model_file), 'utf8');
    if (sha256(modelRaw) !== manifest.model_sha256)
      return { status: 'INVALID', reason: 'current model hash does not match its manifest' };
    const modelJson = JSON.parse(modelRaw) as unknown;
    const model = semanticAnchorModelSchema.parse(modelJson);
    if (
      model.generation_id !== manifest.generation_id ||
      model.run_id !== manifest.run_id ||
      model.prepared_payload_sha256 !== manifest.prepared_payload_sha256
    )
      return { status: 'INVALID', reason: 'current model identity does not match its manifest' };
    const runContractIssue = await validateGenerationAgainstFinalizedRun(
      runDir,
      pointer.data,
      manifest,
      model
    );
    // The pointed files are internally valid immutable evidence, but no longer
    // describe the finalized run inputs installed beside them. Do not reinterpret
    // or remap those targets: a new floor/Story requires a new anchor generation.
    if (runContractIssue !== null) {
      const stale =
        runContractIssue ===
          'current generation does not match the finalized prepared-input receipt' ||
        runContractIssue === 'current generation prepared-input receipt hash is stale' ||
        runContractIssue === 'current generation source or prepared-payload hash is stale' ||
        runContractIssue ===
          'current generation prepared input is stale against immutable policy inputs';
      return stale
        ? { status: 'STALE', reason: runContractIssue }
        : { status: 'INVALID', reason: runContractIssue };
    }
    return { status: 'OK', pointer: pointer.data, manifest, model };
  } catch (error) {
    return {
      status: 'INVALID',
      reason: `current generation is corrupt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Stable first-sentence presentation helper; never model-authored. */
export function semanticAnchorDisplayTitle(citation: SemanticAnchorCitation): string {
  const oneLine = citation.text.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(oneLine)?.[1] ?? oneLine;
  return sentence;
}
