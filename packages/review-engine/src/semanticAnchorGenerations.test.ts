import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { type AccountProjection, DOSSIER_SCHEMA_VERSION } from './dossier.js';
import {
  loadCurrentSemanticAnchorGeneration,
  normalizeSemanticAnchorSubmission,
  SEMANTIC_ANCHOR_CURRENT_FILE,
  SEMANTIC_ANCHOR_MANIFEST_FILE,
  SEMANTIC_ANCHOR_MODEL_FILE,
  semanticAnchorAttemptSchema,
  semanticAnchorCurrentPointerSchema,
  semanticAnchorDisplayTitle,
  semanticAnchorManifestSchema,
  type SemanticAnchorSubmission,
  type SemanticAnchorSubmissionCatalog,
  validateSemanticAnchorSubmission,
} from './semanticAnchorGenerations.js';
import { collectEligibleSemanticAnchorCitations } from './semanticAnchors.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const generationId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const payloadSha = 'f'.repeat(64);

const projection = (): AccountProjection =>
  ({
    schema_version: DOSSIER_SCHEMA_VERSION,
    branch: 'feature',
    floor_input_hash: 'floor-1',
    artifactAliases: { a1: 'artifact-1' },
    accountCore: {
      planSteps: [],
      nonGoals: [],
      planDecisions: [
        {
          citationId: 'plan-decision',
          cp: null,
          text: 'Use the complete representation. It stays inspectable.',
          alternatives: [{ citationId: 'plan-alt', text: 'Use a sampled representation.' }],
        },
      ],
      acceptanceCriteria: [],
      criterionEvidence: [],
      verification: [],
      evaluatorRuns: [],
      checkpoints: [
        {
          artifact: 'a1',
          cp: 1,
          status: 'closed',
          label: null,
          summary: null,
          decisions: [
            {
              citationId: 'cp-decision',
              cp: 1,
              text: 'Persist content-addressed blocks.',
              alternatives: [{ citationId: 'cp-alt', text: 'Persist prompt row numbers.' }],
            },
          ],
          uncertainty: [{ citationId: 'cp-uncertainty', text: 'Deletion-only blocks may occur.' }],
        },
      ],
      ledger: [],
    },
    implicatedHunks: [],
    riskRemainder: [],
    fileInventory: [],
    inventoryMode: 'full',
    manifestSummary: { counts: {}, topOmittedHunks: [] },
  }) as AccountProjection;

const catalog = (): SemanticAnchorSubmissionCatalog => ({
  items: collectEligibleSemanticAnchorCitations(projection()).map((citation, index) => ({
    alias: `i${index + 1}`,
    citation_id: citation.id,
    citation_kind: citation.kind,
  })),
  blocks: [
    {
      alias: 'h1.b1',
      block_key: 'block_rename',
      hunk_alias: 'h1',
      hunk_key: 'hunk_1',
      old_file: 'src/old.ts',
      new_file: 'src/new.ts',
      display_file: 'src/new.ts',
      delete: [{ ref: 'D1', line: 11, line_hash: 'a'.repeat(64) }],
      add: [
        { ref: 'A1', line: 11, line_hash: 'b'.repeat(64) },
        { ref: 'A2', line: 12, line_hash: 'c'.repeat(64) },
      ],
    },
    {
      alias: 'h1.b2',
      block_key: 'block_addition',
      hunk_alias: 'h1',
      hunk_key: 'hunk_1',
      old_file: 'src/old.ts',
      new_file: 'src/new.ts',
      display_file: 'src/new.ts',
      delete: [],
      add: [{ ref: 'A1', line: 20, line_hash: 'd'.repeat(64) }],
    },
  ],
});

const allAssessedUnanchored = (): SemanticAnchorSubmission => ({
  schema_version: 3 as const,
  dispositions: catalog().items.map((item) => ({
    item: item.alias,
    disposition: 'ASSESSED_UNANCHORED' as const,
    targets: [],
  })),
});

const validate = (raw: unknown, submissionCatalog = catalog()) =>
  validateSemanticAnchorSubmission({
    raw,
    generationId,
    runId,
    floorInputHash: 'floor-1',
    preparedPayloadSha256: payloadSha,
    projection: projection(),
    catalog: submissionCatalog,
  });

describe('semantic anchor v3 generation validation', () => {
  it('compiles sparse authored assessments and neutral omissions into a complete exact-once model', () => {
    const result = validate({
      schema_version: 3,
      dispositions: [allAssessedUnanchored().dispositions[0]],
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.model.schema_version).toBe(3);
    expect(result.model.prepared_payload_sha256).toBe(payloadSha);
    expect(result.model.items).toHaveLength(5);
    expect(result.model.items[0]).toMatchObject({
      disposition: 'ASSESSED_UNANCHORED',
      origin: 'REVIEW_MODEL_REPORTED',
    });
    expect(result.model.items.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          disposition: 'NO_ANCHOR_PROPOSED',
          origin: 'ENGINE_RECORDED_OMISSION',
        }),
      ])
    );
    expect(result.model.source).toBe('REVIEW_MODEL_SUBMISSION_COMPILED');
    expect(result.model).not.toHaveProperty('confidence');
    expect(result.model).not.toHaveProperty('title');
  });

  it('resolves a rename-aware block and valid two-sided focus scope', () => {
    const raw = allAssessedUnanchored();
    raw.dispositions[2] = {
      item: 'i3',
      disposition: 'ANCHORED',
      targets: [
        {
          block: 'h1.b1',
          scope: 'FOCUS',
          focus: {
            delete: { start: 'D1', end: 'D1' },
            add: { start: 'A1', end: 'A2' },
          },
        },
      ],
    } as (typeof raw.dispositions)[number];
    const result = validate(raw);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.warnings).toEqual([]);
    const item = result.model.items.find((candidate) => candidate.citation_id === 'cp-decision')!;
    expect(item.disposition).toBe('ANCHORED');
    if (item.disposition !== 'ANCHORED') return;
    expect(item.targets[0]).toMatchObject({
      schema_version: 3,
      block: {
        block_key: 'block_rename',
        old_file: 'src/old.ts',
        new_file: 'src/new.ts',
        delete: { start_line: 11, end_line: 11 },
        add: { start_line: 11, end_line: 12 },
      },
      scope: 'FOCUS',
      focus: {
        delete: { start_line: 11, end_line: 11 },
        add: { start_line: 11, end_line: 12 },
      },
      focus_status: 'ACCEPTED',
      focus_diagnostic_code: null,
      warnings: [],
    });
  });

  it('keeps the block association and drops invalid well-shaped focus atomically', () => {
    const raw = allAssessedUnanchored();
    raw.dispositions[0] = {
      item: 'i1',
      disposition: 'ANCHORED',
      targets: [
        {
          block: 'h1.b1',
          scope: 'FOCUS',
          focus: {
            delete: { start: 'D1', end: 'D1' },
            add: { start: 'A3', end: 'A3' },
          },
        },
      ],
    } as (typeof raw.dispositions)[number];
    const result = validate(raw);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'FOCUS_EXCEEDS_BLOCK' })]);
    const item = result.model.items[0]!;
    expect(item.disposition).toBe('ANCHORED');
    if (item.disposition !== 'ANCHORED') return;
    expect(item.targets[0]!.block.block_key).toBe('block_rename');
    expect(item.targets[0]!.focus).toBeNull();
    expect(item.targets[0]!.focus_status).toBe('REJECTED_INVALID');
    expect(item.targets[0]!.focus_diagnostic_code).toBe('FOCUS_EXCEEDS_BLOCK');
    expect(item.targets[0]!.warnings).toEqual(result.warnings);
  });

  it.each([
    ['FOCUS_EXCEEDS_BLOCK', 'h1.b1', { delete: null, add: { start: 'A3', end: 'A3' } }],
    ['FOCUS_SIDE_NOT_IN_BLOCK', 'h1.b2', { delete: { start: 'D1', end: 'D1' }, add: null }],
    ['FOCUS_RANGE_INVALID', 'h1.b1', { delete: null, add: { start: 'A2', end: 'A1' } }],
  ] as const)('persists the specific %s resolution outcome', (code, block, focus) => {
    const raw = allAssessedUnanchored();
    raw.dispositions[0] = {
      item: 'i1',
      disposition: 'ANCHORED',
      targets: [{ block, scope: 'FOCUS', focus }],
    } as (typeof raw.dispositions)[number];
    const result = validate(raw);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const item = result.model.items[0]!;
    expect(item.disposition).toBe('ANCHORED');
    if (item.disposition !== 'ANCHORED') return;
    expect(item.targets[0]).toMatchObject({
      focus: null,
      focus_status: 'REJECTED_INVALID',
      focus_diagnostic_code: code,
      warnings: [expect.objectContaining({ code })],
    });
  });

  it('associates a pure rename block without inventing changed-row focus', () => {
    const renameCatalog = catalog();
    renameCatalog.blocks = [
      {
        alias: 'h2.b1',
        block_key: 'block_pure_rename',
        hunk_alias: 'h2',
        hunk_key: 'rename_hunk',
        old_file: 'src/before.ts',
        new_file: 'src/after.ts',
        display_file: 'src/before.ts -> src/after.ts',
        delete: [],
        add: [],
      },
    ];
    const raw = allAssessedUnanchored();
    raw.dispositions[0] = {
      item: 'i1',
      disposition: 'ANCHORED',
      targets: [{ block: 'h2.b1', scope: 'WHOLE_BLOCK' }],
    } as (typeof raw.dispositions)[number];
    const result = validate(raw, renameCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const item = result.model.items[0]!;
    expect(item.disposition).toBe('ANCHORED');
    if (item.disposition !== 'ANCHORED') return;
    expect(item.targets[0]).toMatchObject({
      block: {
        block_key: 'block_pure_rename',
        old_file: 'src/before.ts',
        new_file: 'src/after.ts',
        delete: null,
        add: null,
      },
      scope: 'WHOLE_BLOCK',
      focus: null,
      focus_status: 'NONE',
      focus_diagnostic_code: null,
      warnings: [],
    });
  });

  it('rejects duplicate and unknown aliases, authored neutral omissions, and presentation fields', () => {
    const duplicate = allAssessedUnanchored();
    duplicate.dispositions.push(duplicate.dispositions[0]!);
    expect(validate(duplicate).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'SEMANTIC_ANCHOR_DUPLICATE_DISPOSITION'
    );

    const unknown = allAssessedUnanchored();
    unknown.dispositions[0] = {
      item: 'i99',
      disposition: 'ASSESSED_UNANCHORED',
      targets: [],
    };
    expect(validate(unknown).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'SEMANTIC_ANCHOR_UNKNOWN_ITEM'
    );

    expect(
      validate({ ...allAssessedUnanchored(), confidence: 0.9 }).diagnostics.map(
        (diagnostic) => diagnostic.code
      )
    ).toContain('SEMANTIC_ANCHOR_SUBMISSION_SHAPE');
    expect(
      validate({
        schema_version: 3,
        dispositions: [{ item: 'i1', disposition: 'NO_ANCHOR_PROPOSED', targets: [] }],
      }).diagnostics.map((diagnostic) => diagnostic.code)
    ).toContain('SEMANTIC_ANCHOR_SUBMISSION_SHAPE');
  });

  it('rejects unknown and duplicate blocks and requires an explicit target scope', () => {
    const proposed = allAssessedUnanchored();
    const anchor = (targets: unknown[]) => {
      proposed.dispositions[0] = {
        item: 'i1',
        disposition: 'ANCHORED',
        targets,
      } as (typeof proposed.dispositions)[number];
      return validate(proposed);
    };
    expect(
      anchor([{ block: 'h9.b9', scope: 'WHOLE_BLOCK' }]).diagnostics.map((d) => d.code)
    ).toContain('SEMANTIC_ANCHOR_UNKNOWN_BLOCK');
    expect(
      anchor([
        { block: 'h1.b1', scope: 'WHOLE_BLOCK' },
        { block: 'h1.b1', scope: 'WHOLE_BLOCK' },
      ]).diagnostics.map((d) => d.code)
    ).toContain('SEMANTIC_ANCHOR_DUPLICATE_TARGET');
    expect(anchor([{ block: 'h1.b2' }]).diagnostics.map((d) => d.code)).toContain(
      'SEMANTIC_ANCHOR_SUBMISSION_SHAPE'
    );
    expect(
      anchor([{ block: 'h1.b2', scope: 'WHOLE_BLOCK', focus: null }]).diagnostics.map((d) => d.code)
    ).toContain('SEMANTIC_ANCHOR_SUBMISSION_SHAPE');
    const accepted = anchor([{ block: 'h1.b2', scope: 'WHOLE_BLOCK' }]);
    expect(accepted.accepted).toBe(true);
    if (accepted.accepted) expect(accepted.warnings).toEqual([]);
  });

  it('rejects malformed focus scope before geometry resolution', () => {
    const raw = allAssessedUnanchored();
    raw.dispositions[0] = {
      item: 'i1',
      disposition: 'ANCHORED',
      targets: [
        {
          block: 'h1.b1',
          scope: 'FOCUS',
          focus: { delete: null, add: null },
        },
      ],
    } as (typeof raw.dispositions)[number];
    const result = validate(raw);
    expect(result.accepted).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'SEMANTIC_ANCHOR_SUBMISSION_SHAPE'
    );
  });

  it('normalizes exactly one outer JSON string layer and records distinct lineage hashes', () => {
    const cleanText = JSON.stringify(allAssessedUnanchored());
    const clean = normalizeSemanticAnchorSubmission(cleanText);
    expect(clean.normalization).toBe('CLEAN_JSON');
    expect(clean.normalized).toEqual(allAssessedUnanchored());

    const wrappedText = JSON.stringify(cleanText);
    const wrapped = normalizeSemanticAnchorSubmission(wrappedText);
    expect(wrapped.normalization).toBe('JSON_STRING_UNWRAPPED');
    expect(wrapped.normalized).toEqual(allAssessedUnanchored());
    expect(wrapped.raw_sha256).not.toBe(wrapped.normalized_sha256);
    expect(validate(wrapped.normalized).accepted).toBe(true);

    const doubleWrapped = normalizeSemanticAnchorSubmission(JSON.stringify(wrappedText));
    expect(doubleWrapped.normalization).toBe('JSON_STRING_UNWRAPPED');
    expect(typeof doubleWrapped.normalized).toBe('string');
    expect(validate(doubleWrapped.normalized).accepted).toBe(false);

    const invalid = normalizeSemanticAnchorSubmission('{');
    expect(invalid.normalization).toBe('INVALID_JSON');
    expect(invalid.normalized).toBe('{');
    expect(validate(invalid.normalized).accepted).toBe(false);
  });

  it('derives a deterministic first-sentence title without extending model output', () => {
    const citation = collectEligibleSemanticAnchorCitations(projection())[0]!;
    expect(semanticAnchorDisplayTitle(citation)).toBe('Use the complete representation.');
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('current semantic anchor v3 reader', () => {
  it('ignores a historical v2 pointer when no current pointer exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'semantic-current-v2-'));
    roots.push(root);
    const anchors = path.join(root, 'anchors');
    await mkdir(anchors, { recursive: true });
    await writeFile(
      path.join(anchors, 'current-v2.json'),
      JSON.stringify({ schema_version: 2, run_id: runId, generation_id: generationId })
    );
    const loaded = await loadCurrentSemanticAnchorGeneration(root);
    expect(loaded).toEqual({ status: 'ABSENT' });
  });

  it('ignores a historical v1 pointer when no current pointer exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'semantic-current-v1-'));
    roots.push(root);
    const anchors = path.join(root, 'anchors');
    await mkdir(anchors, { recursive: true });
    await writeFile(
      path.join(anchors, 'current-v1.json'),
      JSON.stringify({ schema_version: 1, run_id: runId, generation_id: generationId })
    );
    const loaded = await loadCurrentSemanticAnchorGeneration(root);
    expect(loaded).toEqual({ status: 'ABSENT' });
  });

  it('treats a wrong-version current pointer as invalid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'semantic-current-invalid-'));
    roots.push(root);
    const anchors = path.join(root, 'anchors');
    await mkdir(anchors, { recursive: true });
    await writeFile(
      path.join(anchors, SEMANTIC_ANCHOR_CURRENT_FILE),
      JSON.stringify({ schema_version: 2, run_id: runId, generation_id: generationId })
    );
    expect(await loadCurrentSemanticAnchorGeneration(root)).toEqual({
      status: 'INVALID',
      reason: 'current pointer schema is invalid',
    });
  });

  it('surfaces corrupt v3 current instead of falling back to historical v2', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'semantic-current-v3-'));
    roots.push(root);
    const anchors = path.join(root, 'anchors');
    const generationDir = path.join(anchors, 'generations', generationId);
    await mkdir(generationDir, { recursive: true });
    await writeFile(path.join(anchors, 'current-v2.json'), '{}');

    const startedAt = new Date().toISOString();
    const attempt = semanticAnchorAttemptSchema.parse({
      schema_version: 3,
      generation_id: generationId,
      run_id: runId,
      attempt: 1,
      started_at: startedAt,
      submitted_at: startedAt,
      elapsed_ms: 0,
      runtime_identity: null,
      declared_profile: 'semantic-anchor-profile-v1',
      profile_source: 'CALLER_DECLARED',
      normalization: 'CLEAN_JSON',
      raw_submission_sha256: '1'.repeat(64),
      normalized_submission_sha256: normalizeSemanticAnchorSubmission(
        JSON.stringify(allAssessedUnanchored())
      ).normalized_sha256,
      normalized_submission: allAssessedUnanchored(),
      accepted: true,
      outcome: 'ACCEPTED_CLEAN_FIRST_PASS',
      has_focus_warnings: false,
      diagnostics: [],
      warnings: [],
    });
    const attemptBytes = `${JSON.stringify(attempt, null, 2)}\n`;
    await writeFile(path.join(generationDir, 'attempt-1-v3.json'), attemptBytes);

    const corruptModel = '{"schema_version":3,"broken":true}\n';
    const createdAt = new Date().toISOString();
    const manifest = semanticAnchorManifestSchema.parse({
      schema_version: 3,
      generation_id: generationId,
      run_id: runId,
      status: 'VALID',
      created_at: createdAt,
      lifecycle_started_at: startedAt,
      lifecycle_elapsed_ms: Date.parse(createdAt) - Date.parse(startedAt),
      runtime_identity: null,
      attempt_count: 1,
      declared_profile: 'semantic-anchor-profile-v1',
      profile_source: 'CALLER_DECLARED',
      source: 'REVIEW_MODEL_SUBMISSION_COMPILED',
      prepared_input_schema_version: 4,
      submission_schema_version: 3,
      attempt_schema_version: 3,
      target_schema_version: 3,
      model_schema_version: 3,
      model_file: SEMANTIC_ANCHOR_MODEL_FILE,
      source_hashes: {
        story_review_model_sha256: 'a'.repeat(64),
        account_projection_sha256: 'b'.repeat(64),
        coverage_sha256: 'c'.repeat(64),
        diff_sha256: 'd'.repeat(64),
        accepted_account_envelope_sha256: 'e'.repeat(64),
        compiled_account_payload_sha256: 'f'.repeat(64),
      },
      prepared_receipt_sha256: 'e'.repeat(64),
      prepared_payload_sha256: payloadSha,
      attempt_sha256s: [sha256(attemptBytes)],
      accepted_attempt_sha256: sha256(attemptBytes),
      model_sha256: sha256(corruptModel),
      diagnostic_codes: [],
      warning_codes: [],
      final_attempt_outcome: 'ACCEPTED_CLEAN_FIRST_PASS',
    });
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(generationDir, SEMANTIC_ANCHOR_MODEL_FILE), corruptModel);
    await writeFile(path.join(generationDir, SEMANTIC_ANCHOR_MANIFEST_FILE), manifestBytes);
    await writeFile(
      path.join(anchors, SEMANTIC_ANCHOR_CURRENT_FILE),
      `${JSON.stringify(
        semanticAnchorCurrentPointerSchema.parse({
          schema_version: 3,
          run_id: runId,
          generation_id: generationId,
          manifest_file: SEMANTIC_ANCHOR_MANIFEST_FILE,
          manifest_sha256: sha256(manifestBytes),
        })
      )}\n`
    );

    const loaded = await loadCurrentSemanticAnchorGeneration(root);
    expect(loaded.status).toBe('INVALID');
    if (loaded.status === 'INVALID') expect(loaded.reason).toContain('corrupt');
    expect(await readFile(path.join(anchors, 'current-v2.json'), 'utf8')).toBe('{}');
  });
});
