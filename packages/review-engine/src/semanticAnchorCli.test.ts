import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactLock, atomicWriteFile } from '@orcaops/storage';

import { type AccountProjection, DOSSIER_SCHEMA_VERSION, type ForensicInput } from './dossier.js';
import { reviewStateLockKey } from './reviewState.js';
import { runReview } from './run.js';
import type { ReviewRuntimeDescriptor } from './runtimeIdentity.js';
import {
  loadCurrentSemanticAnchorGeneration,
  SEMANTIC_ANCHOR_CURRENT_FILE,
  SEMANTIC_ANCHOR_MANIFEST_FILE,
  SEMANTIC_ANCHOR_MODEL_FILE,
} from './semanticAnchorGenerations.js';
import {
  prepareSemanticAnchorInput,
  SEMANTIC_ANCHOR_PROFILE,
  SEMANTIC_ANCHOR_RECEIPT_FILE,
} from './semanticAnchors.js';
import type { CoverageInput } from './storyOwnership.js';
import {
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  type StoryReviewModel,
} from './storyReviewModel.js';
import { canonicalJsonSha256 } from './submissionNormalization.js';
import { TWOLANE_RUN_SCHEMA_VERSION } from './twolaneRunCli.js';
import type { TwolaneRunFile } from './twolaneRunFile.js';
import { SLICE_SCHEMA_VERSION } from './twolaneSlice.js';

vi.mock('@orcaops/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/storage')>();
  return { ...actual, atomicWriteFile: vi.fn(actual.atomicWriteFile) };
});

const originalAtomicWrite = vi.mocked(atomicWriteFile).getMockImplementation()!;

const branch = 'semantic-anchor-test';
const runId = '22222222-2222-4222-8222-222222222222';
const finalizedAt = '2026-07-20T12:00:00.000Z';
const decisionId = 'cite:a1:cp1:decision:0';
const uncertaintyId = 'cite:a1:cp1:uncertainty:0';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const projection = (): AccountProjection =>
  ({
    schema_version: DOSSIER_SCHEMA_VERSION,
    branch,
    floor_input_hash: 'floor-1',
    artifactAliases: { a1: 'artifact-1' },
    accountCore: {
      planSteps: [],
      nonGoals: [],
      planDecisions: [],
      acceptanceCriteria: [],
      criterionEvidence: [],
      verification: [],
      evaluatorRuns: [],
      checkpoints: [
        {
          artifact: 'a1',
          cp: 1,
          status: 'closed',
          label: 'implement',
          summary: 'Changed x.',
          decisions: [
            {
              citationId: decisionId,
              cp: 1,
              text: 'Replace the old value with the new value.',
              alternatives: [],
            },
          ],
          uncertainty: [
            {
              citationId: uncertaintyId,
              text: 'A related follow-up may or may not have a direct code association.',
            },
          ],
        },
      ],
      ledger: [],
    },
    implicatedHunks: [],
    riskRemainder: [],
    fileInventory: ['src/x.ts'],
    inventoryMode: 'full',
    manifestSummary: { counts: {}, topOmittedHunks: [] },
  }) as AccountProjection;

const story = (): StoryReviewModel =>
  ({
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch,
    floor_input_hash: 'floor-1',
    label: 'DERIVED',
    banner: 'DERIVED ownership',
    overview: {
      text: 'The branch replaces one value through a captured and attributable change.',
      citations: [decisionId],
    },
    acts: [{ id: 'A1', title: 'Change x', interpretation: null, partIds: ['P1'] }],
    parts: [
      {
        id: 'P1',
        title: 'Replace the value',
        act: 'A1',
        checkpointRefs: ['a1:cp1'],
        interpretation: 'The value changed.',
        citations: [decisionId],
        segments: [
          {
            file: 'src/x.ts',
            hunkKey: 'hunk_1',
            slice: 0,
            owner: { artifact: 'a1', cp: 1 },
            del_range: { start: 1, end: 1 },
            add_range: { start: 1, end: 1 },
            lines: 2,
          },
        ],
        ambiguous: [],
        changedRows: 2,
        ambiguousRows: 0,
        contextOnly: false,
      },
    ],
    residue: { contested: [], unattributed: [], reviewableRows: 0, files: [] },
    metrics: {
      reviewableRows: 2,
      attributedRows: 2,
      attributedPct: 100,
      ambiguousRows: 0,
      contestedRows: 0,
      unattributedRows: 0,
      contributingThreads: 1,
      contributingCheckpoints: 1,
    },
    ledger: [],
    uncertainties: [],
    findings: [],
    questions: [],
    citations: {
      [decisionId]: {
        id: decisionId,
        kind: 'CHECKPOINT_DECISION',
        artifact: 'a1',
        cp: 1,
        text: 'Replace the old value with the new value.',
      },
      [uncertaintyId]: {
        id: uncertaintyId,
        kind: 'CHECKPOINT_UNCERTAINTY',
        artifact: 'a1',
        cp: 1,
        text: 'A related follow-up may or may not have a direct code association.',
      },
    },
    artifactAliases: { a1: 'artifact-1' },
  }) as StoryReviewModel;

const coverage = (): CoverageInput => ({
  items: [
    {
      hunkKey: 'hunk_1',
      file: 'src/x.ts',
      verdict: 'MATCHED',
      old_start: 1,
      new_start: 1,
      added_lines: 1,
      removed_lines: 1,
      units: [],
    },
  ],
  summary: {
    excluded: 0,
    unreviewable: 0,
    matched_rows: 2,
    unexplained_rows: 0,
    ambiguous_rows: 0,
    reviewable_rows: 2,
  },
});

const diff =
  'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n';

const forensicInput = (): ForensicInput => ({
  schema_version: 2,
  baseSha: null,
  diff,
  excludedPaths: [],
  unreviewablePaths: [],
  policyStubs: [],
  metrics: {
    eligibleFiles: 1,
    excludedFiles: 0,
    unreviewableFiles: 0,
    policyStubFiles: 0,
    policyStubRows: 0,
    policyStubBytes: 0,
    eligibleDiffBytes: Buffer.byteLength(diff),
  },
});

let root: string;
let runDir: string;
let out: string[];
let err: string[];
let runtime: ReviewRuntimeDescriptor;

const lastJson = (): Record<string, unknown> => {
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const line = out[index]!.trim();
    if (line.startsWith('{')) return JSON.parse(line) as Record<string, unknown>;
  }
  throw new Error(`no JSON output; stderr=${err.join('')}`);
};

async function writePreparedRun(): Promise<void> {
  runDir = path.join(root, '.orcaops', 'reviews', branch, 'twolane', runId);
  await mkdir(runDir, { recursive: true });
  const s = story();
  const p = projection();
  const c = coverage();
  const f = forensicInput();
  const storyBytes = serializeStoryReviewModel(s);
  const projectionBytes = `${JSON.stringify(p, null, 2)}\n`;
  const coverageBytes = `${JSON.stringify(c, null, 2)}\n`;
  const forensicInputBytes = `${JSON.stringify(f, null, 2)}\n`;
  const acceptedAccount = {
    schema_version: 1,
    normalization_code: 'CLEAN_JSON',
    normalization_codes: ['CLEAN_JSON'],
    normalized_authored: { schema_version: 1, acts: [], questions: [] },
    compiled_payload: { acts: [], parts: [], questions: [] },
    inner: {
      raw_submission_sha256: 'c'.repeat(64),
      normalized_authored_sha256: 'd'.repeat(64),
      compiled_payload_sha256: '',
      diagnostic_codes: [],
    },
  };
  acceptedAccount.inner.compiled_payload_sha256 = canonicalJsonSha256(
    acceptedAccount.compiled_payload
  );
  const accountLineage = {
    acceptedEnvelopeSha256: canonicalJsonSha256(acceptedAccount),
    compiledPayloadSha256: acceptedAccount.inner.compiled_payload_sha256,
  };
  const prepared = prepareSemanticAnchorInput({
    runId,
    storyModel: s,
    storyModelBytes: storyBytes,
    accountProjection: p,
    accountProjectionBytes: projectionBytes,
    coverage: c,
    coverageBytes,
    pinnedDiffText: diff,
    forensicInput: f,
    forensicInputBytes,
    accountLineage,
  });
  if (prepared.receipt.status !== 'READY' || prepared.payload === null)
    throw new Error('test preparation must be READY');
  const inputs = {
    projection: 'pinned-projection',
    coverage: 'pinned-coverage',
    diff: 'pinned-diff',
  };
  await Promise.all([
    writeFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), storyBytes),
    writeFile(path.join(runDir, 'account-projection-v1.json'), projectionBytes),
    writeFile(path.join(runDir, 'coverage-v1.json'), coverageBytes),
    writeFile(path.join(runDir, 'diff.patch'), diff),
    writeFile(path.join(runDir, 'forensic-input-v1.json'), forensicInputBytes),
    writeFile(path.join(runDir, 'accepted-account.json'), `${JSON.stringify(acceptedAccount)}\n`),
    writeFile(path.join(runDir, prepared.receipt.payload_file!), prepared.payload),
    writeFile(
      path.join(runDir, SEMANTIC_ANCHOR_RECEIPT_FILE),
      `${JSON.stringify(prepared.receipt, null, 2)}\n`
    ),
    writeFile(
      path.join(runDir, 'run-v1.json'),
      // The complete persisted run shape — the reader validates the strict
      // schema, so the seed must be what the real writer emits. `satisfies`
      // makes schema drift a compile error here instead of a runtime failure.
      JSON.stringify({
        schema_version: TWOLANE_RUN_SCHEMA_VERSION,
        run_id: runId,
        branch,
        mode: 'routine',
        created_at: '2026-07-20T11:00:00.000Z',
        input_shas: inputs,
        slice_state: {
          schema_version: SLICE_SCHEMA_VERSION,
          lanes: {
            account: {
              attempts: 1,
              accepted: true,
              repairCredit: 1,
              outcome: 'ACCEPTED_CLEAN_FIRST_PASS',
              diagnostics: [],
            },
            forensic: {
              attempts: 1,
              accepted: true,
              repairCredit: 1,
              outcome: 'ACCEPTED_CLEAN_FIRST_PASS',
              diagnostics: [],
            },
          },
        },
        lane_inputs_served: {},
        attempts: [],
        account_lineage: {
          raw_submission_sha256: 'seed-raw-sha',
          normalized_authored_sha256: 'seed-normalized-sha',
          compiled_payload_sha256: accountLineage.compiledPayloadSha256,
          accepted_envelope_sha256: accountLineage.acceptedEnvelopeSha256,
          normalization_code: 'CLEAN_JSON',
          normalization_codes: ['CLEAN_JSON'],
          diagnostic_codes: [],
        },
        latency_input_bytes: 0,
        runtime_identity: null,
        execution_profile: {
          host: null,
          host_version: null,
          model: null,
          effort: null,
          launcher_mode: null,
          instruction_hash: null,
        },
        finalized: { at: finalizedAt, outcome: 'FULL' },
      } satisfies TwolaneRunFile)
    ),
    writeFile(
      path.join(runDir, 'run-record-v1.json'),
      JSON.stringify({
        run_id: runId,
        branch,
        outcome: 'FULL',
        finalized_at: finalizedAt,
        input_shas: inputs,
        account_lineage: {
          accepted_envelope_sha256: accountLineage.acceptedEnvelopeSha256,
          compiled_payload_sha256: accountLineage.compiledPayloadSha256,
        },
        semantic_anchor_input: {
          ...prepared.receipt,
          receipt_file: SEMANTIC_ANCHOR_RECEIPT_FILE,
        },
      })
    ),
  ]);
}

const submitFile = async (name: string, raw: unknown): Promise<string> => {
  const file = path.join(root, name);
  await writeFile(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
  return file;
};

const command = (input: string, generation?: string): Promise<number> =>
  runReview(
    [
      'review',
      'semantic-anchor-submit',
      '--run',
      runId,
      '--profile',
      SEMANTIC_ANCHOR_PROFILE,
      '--input',
      input,
      ...(generation === undefined ? [] : ['--generation', generation]),
      '--root',
      root,
      '--json',
    ],
    process.env,
    undefined,
    runtime
  );

const validSubmission = () => ({
  schema_version: 3,
  dispositions: [
    {
      item: 'i1',
      disposition: 'ANCHORED',
      targets: [
        {
          block: 'h1.b1',
          scope: 'FOCUS',
          focus: {
            delete: { start: 'D1', end: 'D1' },
            add: { start: 'A1', end: 'A1' },
          },
        },
      ],
    },
  ],
});

beforeEach(async () => {
  vi.mocked(atomicWriteFile).mockImplementation(originalAtomicWrite).mockClear();
  root = await mkdtemp(path.join(tmpdir(), 'semantic-anchor-cli-'));
  const runtimeRoot = path.join(root, 'runtime');
  const entrypointPath = path.join(runtimeRoot, 'dist', 'sidecar.js');
  // Exercise executable-identity hashing against a minimal runtime whose cost
  // cannot grow with unrelated workspace build output.
  await mkdir(path.dirname(entrypointPath), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(runtimeRoot, 'package.json'),
      JSON.stringify({ name: '@orcaops/review-engine', version: '0.0.0' })
    ),
    writeFile(entrypointPath, 'export {};'),
  ]);
  runtime = { packageRoot: runtimeRoot, entrypointPath };
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  await writePreparedRun();
});

afterEach(async () => {
  vi.mocked(atomicWriteFile).mockImplementation(originalAtomicWrite).mockClear();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('semantic-anchor-submit lifecycle', () => {
  it('waits for the review-state lock before writing a generation', async () => {
    const input = await submitFile('locked.json', validSubmission());
    const lock = new ArtifactLock({
      locksDir: path.join(root, '.orcaops', 'tmp', 'locks'),
      containmentRoot: root,
    });
    let markAcquired!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = lock.withLock(reviewStateLockKey(branch), async () => {
      markAcquired();
      await blocked;
    });
    await acquired;

    const pending = command(input);
    try {
      const state = await Promise.race([
        pending.then(() => 'completed' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 75)),
      ]);
      expect(state).toBe('waiting');
      await expect(access(path.join(runDir, 'anchors'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release();
      await held;
    }
    expect(await pending).toBe(0);
  });

  it('installs a validated immutable v3 generation with a durable block and focus', async () => {
    expect(await command(await submitFile('valid.json', validSubmission()))).toBe(0);
    const response = lastJson();
    expect(response.accepted).toBe(true);
    expect(response.status).toBe('CURRENT');
    expect(response.repair_remaining).toBe(0);
    expect(response.disposition_counts).toEqual({
      ANCHORED: 1,
      ASSESSED_UNANCHORED: 0,
      NO_ANCHOR_PROPOSED: 1,
    });
    const loaded = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(loaded.status).toBe('OK');
    if (loaded.status !== 'OK') return;
    expect(loaded.manifest.profile_source).toBe('CALLER_DECLARED');
    expect(loaded.manifest.source).toBe('REVIEW_MODEL_SUBMISSION_COMPILED');
    expect(loaded.model.items[0]).toMatchObject({
      citation_id: decisionId,
      disposition: 'ANCHORED',
      origin: 'REVIEW_MODEL_PROPOSED',
      targets: [
        {
          schema_version: 3,
          block: {
            old_file: 'src/x.ts',
            new_file: 'src/x.ts',
            hunk_key: 'hunk_1',
            delete: { start_line: 1, end_line: 1 },
            add: { start_line: 1, end_line: 1 },
          },
          scope: 'FOCUS',
          focus: {
            delete: { start_line: 1, end_line: 1 },
            add: { start_line: 1, end_line: 1 },
          },
          focus_status: 'ACCEPTED',
          focus_diagnostic_code: null,
        },
      ],
    });
    expect(loaded.model.items[1]).toMatchObject({
      citation_id: uncertaintyId,
      disposition: 'NO_ANCHOR_PROPOSED',
      origin: 'ENGINE_RECORDED_OMISSION',
      targets: [],
    });
    const generationDir = path.dirname(response.model_path as string);
    const attempt = JSON.parse(
      await readFile(path.join(root, generationDir, 'attempt-1-v3.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(attempt).toMatchObject({
      schema_version: 3,
      profile_source: 'CALLER_DECLARED',
      normalization: 'CLEAN_JSON',
      accepted: true,
      outcome: 'ACCEPTED_CLEAN_FIRST_PASS',
      has_focus_warnings: false,
    });
    expect(attempt.elapsed_ms).toEqual(expect.any(Number));
    expect(attempt.runtime_identity).toMatchObject({
      compiledRuntimeManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(loaded.manifest.lifecycle_elapsed_ms).toEqual(expect.any(Number));
    expect(attempt.normalized_submission).toEqual(validSubmission());
    expect(attempt).not.toHaveProperty('raw_submission');
    expect(attempt.raw_submission_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.normalized_submission_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes one stringified JSON object layer and persists its canonical object with lineage hashes', async () => {
    const wrapped = JSON.stringify(JSON.stringify(validSubmission()));
    expect(await command(await submitFile('wrapped.json', wrapped))).toBe(0);
    const response = lastJson();
    expect(response.accepted).toBe(true);
    expect(response.normalization).toBe('JSON_STRING_UNWRAPPED');
    const generationDir = path.dirname(response.model_path as string);
    const attemptBytes = await readFile(
      path.join(root, generationDir, 'attempt-1-v3.json'),
      'utf8'
    );
    const attempt = JSON.parse(attemptBytes) as Record<string, unknown>;
    expect(attempt.normalization).toBe('JSON_STRING_UNWRAPPED');
    expect(attempt.outcome).toBe('ACCEPTED_NORMALIZED_FIRST_PASS');
    expect(attempt.raw_submission_sha256).toBe(sha256(wrapped));
    expect(attempt.normalized_submission).toEqual(validSubmission());
    expect(attempt).not.toHaveProperty('raw_submission');
  });

  it('rejects recursively stringified semantic JSON after one safe unwrap', async () => {
    const recursivelyWrapped = JSON.stringify(JSON.stringify(JSON.stringify(validSubmission())));
    expect(await command(await submitFile('recursive-wrapper.json', recursivelyWrapped))).toBe(0);
    const response = lastJson();
    expect(response).toMatchObject({
      accepted: false,
      status: 'PENDING',
      outcome: 'REJECTED_FIRST_PASS',
    });
    expect(response.diagnostics).toEqual([
      expect.objectContaining({ code: 'SEMANTIC_ANCHOR_SUBMISSION_SHAPE' }),
    ]);
  });

  it('keeps a valid FOCUS association current when its geometry is invalid, without spending repair', async () => {
    const submission = validSubmission();
    submission.dispositions[0]!.targets[0]!.focus!.add = { start: 'A99', end: 'A99' };
    expect(await command(await submitFile('focus-warning.json', submission))).toBe(0);
    const response = lastJson();
    expect(response).toMatchObject({
      accepted: true,
      status: 'CURRENT',
      repair_remaining: 0,
      warnings: [expect.objectContaining({ code: 'FOCUS_EXCEEDS_BLOCK' })],
    });
    const loaded = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(loaded.status).toBe('OK');
    if (loaded.status !== 'OK') return;
    const item = loaded.model.items[0]!;
    expect(item.disposition).toBe('ANCHORED');
    if (item.disposition !== 'ANCHORED') return;
    expect(item.targets[0]!.block.block_key).toMatch(/^block_/);
    expect(item.targets[0]!.scope).toBe('FOCUS');
    expect(item.targets[0]!.focus).toBeNull();
    expect(item.targets[0]!.focus_status).toBe('REJECTED_INVALID');
    expect(item.targets[0]!.focus_diagnostic_code).toBe('FOCUS_EXCEEDS_BLOCK');
    expect(loaded.manifest.warning_codes).toEqual(['FOCUS_EXCEEDS_BLOCK']);
    expect(loaded.manifest.final_attempt_outcome).toBe('ACCEPTED_CLEAN_FIRST_PASS');
    expect(loaded.manifest.attempt_count).toBe(1);
    expect(loaded.manifest).toMatchObject({
      prepared_input_schema_version: 4,
      submission_schema_version: 3,
      attempt_schema_version: 3,
      target_schema_version: 3,
      model_schema_version: 3,
      model_file: SEMANTIC_ANCHOR_MODEL_FILE,
    });
    expect(loaded.pointer.manifest_file).toBe(SEMANTIC_ANCHOR_MANIFEST_FILE);
  });

  it('permits exactly one repair and only a valid terminal generation replaces current', async () => {
    expect(await command(await submitFile('baseline.json', validSubmission()))).toBe(0);
    const baseline = lastJson().generation_id as string;

    const invalid = {
      schema_version: 3,
      dispositions: [{ item: 'i99', disposition: 'ASSESSED_UNANCHORED', targets: [] }],
    };
    expect(await command(await submitFile('invalid.json', invalid))).toBe(0);
    const pending = lastJson();
    expect(pending.accepted).toBe(false);
    expect(pending.status).toBe('PENDING');
    expect(pending.repair_remaining).toBe(1);
    const pendingId = pending.generation_id as string;
    let current = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(current.status).toBe('OK');
    if (current.status === 'OK') expect(current.pointer.generation_id).toBe(baseline);

    expect(await command(await submitFile('repair.json', validSubmission()), pendingId)).toBe(0);
    expect(lastJson().status).toBe('CURRENT');
    current = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(current.status).toBe('OK');
    if (current.status === 'OK') expect(current.pointer.generation_id).toBe(pendingId);
    expect(await command(await submitFile('third.json', validSubmission()), pendingId)).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain('already terminal');
  });

  it('terminally rejects a failed repair without replacing the prior current generation', async () => {
    expect(await command(await submitFile('baseline.json', validSubmission()))).toBe(0);
    const baseline = lastJson().generation_id as string;
    const invalidFile = await submitFile('invalid.json', {
      schema_version: 3,
      dispositions: [{ item: 'i99', disposition: 'ASSESSED_UNANCHORED', targets: [] }],
    });
    expect(await command(invalidFile)).toBe(0);
    const rejectedId = lastJson().generation_id as string;
    expect(await command(invalidFile, rejectedId)).toBe(0);
    expect(lastJson().status).toBe('REJECTED');
    const current = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(current.status).toBe('OK');
    if (current.status === 'OK') expect(current.pointer.generation_id).toBe(baseline);
  });

  it('refuses non-finalized or stale prepared sources before allocating a generation', async () => {
    const run = JSON.parse(await readFile(path.join(runDir, 'run-v1.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    run.finalized = null;
    await writeFile(path.join(runDir, 'run-v1.json'), JSON.stringify(run));
    expect(await command(await submitFile('valid.json', validSubmission()))).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain('not terminally finalized');

    await writePreparedRun();
    await writeFile(path.join(runDir, 'diff.patch'), `${diff}tampered\n`);
    expect(await command(await submitFile('valid-2.json', validSubmission()))).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain('stale');
  });

  it.each([1, 2, 3])(
    'rejects historical v%s preparation with a typed error before v4 shape validation',
    async (version) => {
      const recordFile = path.join(runDir, 'run-record-v1.json');
      const record = JSON.parse(await readFile(recordFile, 'utf8')) as {
        semantic_anchor_input: Record<string, unknown>;
      };
      record.semantic_anchor_input = {
        schema_version: version,
        status: 'READY',
        receipt_file: `semantic-anchor-input-v${version}.json`,
      };
      await writeFile(recordFile, JSON.stringify(record));

      expect(await command(await submitFile(`valid-v${version}.json`, validSubmission()))).toBe(1);
      expect((lastJson().error as { code: string }).code).toBe(
        'UNSUPPORTED_SEMANTIC_ANCHOR_INPUT_VERSION'
      );
    }
  );

  it('rerenders from immutable forensic policy input rather than the full pinned diff', async () => {
    const forensicFile = path.join(runDir, 'forensic-input-v1.json');
    const forensic = JSON.parse(await readFile(forensicFile, 'utf8')) as ForensicInput;
    forensic.excludedPaths.push('.orcaops/newly-excluded.json');
    forensic.metrics.excludedFiles += 1;
    await writeFile(forensicFile, JSON.stringify(forensic));

    expect(await command(await submitFile('policy-stale.json', validSubmission()))).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain('stale');
  });

  it('marks an installed current generation stale when its forensic target policy changes', async () => {
    expect(await command(await submitFile('valid-current.json', validSubmission()))).toBe(0);
    const forensicFile = path.join(runDir, 'forensic-input-v1.json');
    const forensic = JSON.parse(await readFile(forensicFile, 'utf8')) as ForensicInput;
    forensic.policyStubs.push({
      path: 'fixtures/late-policy.json',
      adds: 1,
      dels: 0,
      bytes: 100,
      reason: 'review.stub_paths',
    });
    forensic.metrics.policyStubFiles += 1;
    await writeFile(forensicFile, JSON.stringify(forensic));

    const loaded = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(loaded.status).toBe('STALE');
    if (loaded.status === 'STALE') expect(loaded.reason).toContain('policy inputs');
  });

  it('marks a current generation invalid when its finalized receipt is historical v1', async () => {
    expect(await command(await submitFile('valid-historical.json', validSubmission()))).toBe(0);
    const recordFile = path.join(runDir, 'run-record-v1.json');
    const record = JSON.parse(await readFile(recordFile, 'utf8')) as {
      semantic_anchor_input: Record<string, unknown>;
    };
    record.semantic_anchor_input.schema_version = 1;
    await writeFile(recordFile, JSON.stringify(record));

    const loaded = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(loaded.status).toBe('INVALID');
    if (loaded.status === 'INVALID') expect(loaded.reason).toContain('schema 1 is unsupported');
  });

  it('rejects an unregistered caller profile and an oversized submission', async () => {
    const validFile = await submitFile('valid.json', validSubmission());
    expect(
      await runReview(
        [
          'review',
          'semantic-anchor-submit',
          '--run',
          runId,
          '--profile',
          'invented-profile',
          '--input',
          validFile,
          '--root',
          root,
          '--json',
        ],
        process.env,
        undefined,
        runtime
      )
    ).toBe(2);
    expect((lastJson().error as { message: string }).message).toContain(
      `--profile must be ${SEMANTIC_ANCHOR_PROFILE}`
    );

    const tooLarge = await submitFile('too-large.json', 'x'.repeat(128_001));
    expect(await command(tooLarge)).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain(
      '128000-byte profile ceiling'
    );
  });

  it('rejects a run record that disagrees with terminal finalization', async () => {
    const recordFile = path.join(runDir, 'run-record-v1.json');
    const record = JSON.parse(await readFile(recordFile, 'utf8')) as Record<string, unknown>;
    record.finalized_at = '2026-07-20T12:00:01.000Z';
    await writeFile(recordFile, JSON.stringify(record));

    expect(await command(await submitFile('valid.json', validSubmission()))).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain(
      'does not match the terminal run identity, outcome, timestamp, or inputs'
    );
  });

  it.each([
    'attempt-1-v3.json',
    SEMANTIC_ANCHOR_MODEL_FILE,
    SEMANTIC_ANCHOR_MANIFEST_FILE,
    SEMANTIC_ANCHOR_CURRENT_FILE,
  ])('preserves the previous current generation when writing %s fails', async (suffix) => {
    expect(await command(await submitFile('baseline.json', validSubmission()))).toBe(0);
    const baseline = lastJson().generation_id as string;
    vi.mocked(atomicWriteFile).mockImplementation(async (file, data) => {
      if (String(file).endsWith(suffix)) throw new Error(`simulated ${suffix} interruption`);
      return originalAtomicWrite(file, data);
    });

    expect(await command(await submitFile(`fault-${suffix}.json`, validSubmission()))).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain(
      `simulated ${suffix} interruption`
    );
    const current = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(current.status).toBe('OK');
    if (current.status === 'OK') expect(current.pointer.generation_id).toBe(baseline);
  });

  it('keeps a repair retryable when its immutable attempt write is interrupted', async () => {
    expect(await command(await submitFile('baseline.json', validSubmission()))).toBe(0);
    const baseline = lastJson().generation_id as string;
    const invalidFile = await submitFile('invalid.json', {
      schema_version: 3,
      dispositions: [{ item: 'i99', disposition: 'ASSESSED_UNANCHORED', targets: [] }],
    });
    expect(await command(invalidFile)).toBe(0);
    const pending = lastJson().generation_id as string;
    vi.mocked(atomicWriteFile).mockImplementation(async (file, data) => {
      if (String(file).endsWith('attempt-2-v3.json'))
        throw new Error('simulated repair attempt interruption');
      return originalAtomicWrite(file, data);
    });

    const repairFile = await submitFile('repair.json', validSubmission());
    expect(await command(repairFile, pending)).toBe(1);
    let current = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(current.status).toBe('OK');
    if (current.status === 'OK') expect(current.pointer.generation_id).toBe(baseline);

    vi.mocked(atomicWriteFile).mockImplementation(originalAtomicWrite);
    expect(await command(repairFile, pending)).toBe(0);
    expect(lastJson().status).toBe('CURRENT');
    current = await loadCurrentSemanticAnchorGeneration(runDir);
    expect(current.status).toBe('OK');
    if (current.status === 'OK') expect(current.pointer.generation_id).toBe(pending);
  });

  it('exposes the explicit workflow in general and subcommand help', async () => {
    expect(await runReview(['review', '--help', '--root', root], process.env)).toBe(0);
    expect(out.join('')).toContain(
      'semantic-anchor-submit  validate + install explicit non-adjudicating semantic associations'
    );
    expect(out.join('')).toContain('anchor         mint code anchors + finding keys');
    out = [];
    expect(
      await runReview(['review', 'semantic-anchor-submit', '--help', '--root', root], process.env)
    ).toBe(0);
    expect(out.join('')).toContain(
      'review semantic-anchor-submit --run <run-id> --profile semantic-anchor-profile-v1'
    );
    expect(out.join('')).not.toContain('semantic-anchor-start');
  });
});
