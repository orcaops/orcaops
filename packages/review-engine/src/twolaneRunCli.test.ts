import { readFileSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';
import { ArtifactLock } from '@orcaops/storage';

import { buildClaimLedger } from './claimLedger.js';
import { CURRENT_STORY_POINTER_FILE } from './currentStory.js';
import {
  type AccountProjection,
  buildDossier,
  type DossierV1,
  type ForensicInput,
} from './dossier.js';
import { ensureReviewStateVersion, reviewStateLockKey } from './reviewState.js';
import { REVIEW_USAGE, runReview } from './run.js';
import type { ReviewRuntimeDescriptor } from './runtimeIdentity.js';
import { parseStoryReviewModel } from './storyReviewModel.js';
import { canonicalJsonSha256, normalizeSubmission } from './submissionNormalization.js';
import {
  LANE_CONTRACTS,
  latencyProfileFor,
  latencyTierFor,
  ownershipSummaryFromComposed,
  renderForensicRoutineMd,
  ROUTINE_ORDER_MESSAGE,
  runTwolaneRun,
} from './twolaneRunCli.js';
import { accountCitableIds, buildAccountPromptAliases } from './twolaneSlice.js';

const CONSTANTS_FIX = path.join(__dirname, '..', 'fixtures', 'twolane-cli-constants.json');
const BRANCH = 'twolane-e2e';
const GENERATED_AT = '2026-07-23T00:00:00.000Z';
const ARTIFACT = '11111111-1111-4111-8111-111111111111';
const RETAINED_DIFF = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  '--- a/src/fixture.ts',
  '+++ b/src/fixture.ts',
  '@@ -1,0 +1 @@',
  '+stable fixture row',
  '',
].join('\n');

let root: string;
let out: string[];
let err: string[];
let runtime: ReviewRuntimeDescriptor;

const run = (argv: string[]): Promise<number> =>
  runReview(
    ['review', ...argv, '--branch', BRANCH, '--root', root, '--json'],
    process.env,
    undefined,
    runtime
  );

/** Last parseable JSON line the verb printed (emit() writes are atomic lines). */
const lastJson = (): Record<string, unknown> => {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const line = out[i]!.trim();
    if (line.startsWith('{')) return JSON.parse(line) as Record<string, unknown>;
  }
  throw new Error(`no JSON output captured; stderr: ${err.join('')}`);
};

const buildPayloadFixture = (): {
  dossier: DossierV1;
  accountProjection: AccountProjection;
  forensicInput: ForensicInput;
} => {
  const floor = JSON.parse(
    JSON.stringify(buildReviewFloorFixture('clean').floor).replaceAll('artifact-fixture', ARTIFACT)
  ) as ReturnType<typeof buildReviewFloorFixture>['floor'];
  floor.scope.branch = BRANCH;
  floor.scope.branch_slug = BRANCH;
  floor.integrity.push({ artifact: ARTIFACT, cp: 2, verified: true });
  floor.outline.threads[0]!.checkpoints.push({
    checkpointKey: 'chap_fixture_2',
    order: 2,
    checkpoint: { artifact: ARTIFACT, cp: 2, label: 'Second fixture checkpoint' },
    summary: 'Second fixture checkpoint',
    members: [{ artifact: ARTIFACT, cp: 2 }],
    sliceRefs: [],
    citationIds: [`cite:${ARTIFACT}:cp2:decision:0`],
  });
  floor.citations.push({
    id: `cite:${ARTIFACT}:cp2:decision:0`,
    kind: 'CHECKPOINT_DECISION',
    artifact: ARTIFACT,
    cp: 2,
    text: 'Keep the second deterministic checkpoint stable.',
  });
  return buildDossier({
    floor,
    retainedDiff: RETAINED_DIFF,
    ledgerEntries: buildClaimLedger({
      floor,
      checkpoints: [],
      generatedAt: GENERATED_AT,
    }).entries,
    branch: BRANCH,
    baseSha: 'basesha1234',
    generatedAt: GENERATED_AT,
  });
};

// Build the deterministic dossier once. Helpers clone mutable views so each
// test stays isolated without repeating the expensive projection pipeline.
const PAYLOAD_FIXTURE = buildPayloadFixture();
const PAYLOAD_FILES = [
  ['dossier-v1.json', JSON.stringify(PAYLOAD_FIXTURE.dossier)],
  ['account-projection-v1.json', JSON.stringify(PAYLOAD_FIXTURE.accountProjection)],
  ['forensic-input-v1.json', JSON.stringify(PAYLOAD_FIXTURE.forensicInput)],
] as const;

const dossierFix = (): DossierV1 => structuredClone(PAYLOAD_FIXTURE.dossier);
const projectionFix = (): AccountProjection => structuredClone(PAYLOAD_FIXTURE.accountProjection);

/** A changed non-capture file the forensic lane may anchor to. */
const changedFile = (): string => {
  const d = dossierFix();
  const entry = d.file_index.find((f) => !f.capture && f.newPath !== null);
  return (entry?.newPath ?? entry?.path)!;
};
/** A real citation id from the served projection. */
const citationId = (): string => {
  const p = projectionFix();
  for (const cp of p.accountCore.checkpoints) for (const dec of cp.decisions) return dec.citationId;
  throw new Error('fixture projection has no decision citation');
};

const forensicOk = () => ({
  findings: [
    {
      claim: 'The change flips a persisted default without a migration guard.',
      file: changedFile(),
      related_files: [],
      severity: 'CAUTION',
      confidence: 'HIGH',
    },
  ],
  questions: [],
});
/** A valid full Story over the served projection: every checkpoint in one Part. */
const accountOk = () => {
  const projection = projectionFix();
  const c = projection.accountCore;
  const aliases = buildAccountPromptAliases(projection);
  const checkpointAlias = new Map(
    aliases.checkpoints.map((entry) => [entry.canonical, entry.alias])
  );
  const citationAlias = new Map(aliases.citations.map((entry) => [entry.canonical, entry.alias]));
  const cite = (cp: (typeof c.checkpoints)[number]): string =>
    cp.decisions[0]?.citationId ??
    cp.uncertainty[0]?.citationId ??
    c.planSteps[0]?.citationId ??
    c.ledger[0]!.id;
  return {
    schema_version: 1 as const,
    overview: {
      text: 'The branch carries one coherent change from captured intent through implementation.',
      citations: [citationAlias.get(cite(c.checkpoints[0]!))!],
    },
    acts: [
      {
        title: 'The change',
        interpretation: 'One causal arc.',
        parts: c.checkpoints.map((cp, i) => ({
          title: `Part ${i + 1}`,
          checkpoints: [checkpointAlias.get(`${cp.artifact}:cp${cp.cp}`)!],
          interpretation: `Part ${i + 1} advances the change.`,
          citations: [citationAlias.get(cite(cp))!],
        })),
      },
    ],
    questions: [] as unknown[],
  };
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'twolane-run-'));
  const reviewDir = path.join(root, '.orcaops', 'reviews', BRANCH);
  const runtimeRoot = path.join(root, 'runtime');
  const entrypointPath = path.join(runtimeRoot, 'dist', 'sidecar.js');
  await ensureReviewStateVersion(reviewDir, root);
  // Exercise executable-identity hashing against a minimal runtime whose cost
  // cannot grow with unrelated workspace build output.
  await mkdir(path.dirname(entrypointPath), { recursive: true });
  await Promise.all(
    PAYLOAD_FILES.map(([target, contents]) =>
      writeFile(path.join(reviewDir, target), contents)
    ).concat(
      writeFile(
        path.join(runtimeRoot, 'package.json'),
        JSON.stringify({ name: '@orcaops/review-engine', version: '0.0.0' })
      ),
      writeFile(entrypointPath, 'export {};')
    )
  );
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function payloadFile(name: string, value: unknown): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, JSON.stringify(value, null, 1));
  return file;
}

async function startRun(): Promise<string> {
  expect(await run(['start'])).toBe(0);
  return lastJson().run_id as string;
}

/** Pin a 1-owned / 2-gap coverage snapshot so the stored percentage proves no rounding. */
async function installDerivedOwnershipFixture(missingBoundaryCheckpoints = 0): Promise<void> {
  const projection = projectionFix();
  const firstCheckpoint = projection.accountCore.checkpoints[0]!;
  const artifact = projection.artifactAliases[firstCheckpoint.artifact]!;
  const reviewDir = path.join(root, '.orcaops', 'reviews', BRANCH);
  const dossier = dossierFix();
  dossier.missing_boundary_checkpoints = missingBoundaryCheckpoints;
  await writeFile(path.join(reviewDir, 'dossier-v1.json'), JSON.stringify(dossier));
  await writeFile(
    path.join(reviewDir, 'coverage-v1.json'),
    JSON.stringify({
      items: [
        {
          hunkKey: 'hunk_ownership_summary',
          file: 'src/x.ts',
          verdict: 'MATCHED',
          old_start: 0,
          new_start: 1,
          added_lines: 3,
          removed_lines: 0,
          units: [
            {
              kind: 'owned_slice',
              slice: 0,
              patch_row_start: 0,
              patch_row_end: 0,
              del_range: null,
              add_range: { start: 1, end: 1 },
              lines: 1,
              owner: { kind: 'checkpoint', artifact, cp: firstCheckpoint.cp },
            },
            {
              kind: 'gap_slice',
              slice: 1,
              patch_row_start: 1,
              patch_row_end: 2,
              del_range: null,
              add_range: { start: 2, end: 3 },
              lines: 2,
              owner: { kind: 'gap', segment: `${artifact}:cp${firstCheckpoint.cp}->worktree` },
            },
          ],
        },
      ],
      summary: {
        excluded: 0,
        unreviewable: 0,
        matched_rows: 1,
        unexplained_rows: 2,
        ambiguous_rows: 0,
        reviewable_rows: 3,
      },
    })
  );
}

const submit = (runId: string, lane: string, file: string) =>
  run([
    'lane-submit',
    '--run',
    runId,
    '--lane',
    lane,
    '--isolation',
    'sequential',
    '--input',
    file,
  ]);

describe('routine two-lens run lifecycle', () => {
  it('waits for the review-state lock before creating a nested run', async () => {
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
    const held = lock.withLock(reviewStateLockKey(BRANCH), async () => {
      markAcquired();
      await blocked;
    });
    await acquired;

    const pending = run(['start']);
    try {
      const state = await Promise.race([
        pending.then(() => 'completed' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 75)),
      ]);
      expect(state).toBe('waiting');
      await expect(
        access(path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release();
      await held;
    }
    expect(await pending).toBe(0);
  });

  it('waits for the review-state lock before mutating an existing run', async () => {
    const runId = await startRun();
    const runFile = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId, 'run-v1.json');
    const before = await readFile(runFile, 'utf8');
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
    const held = lock.withLock(reviewStateLockKey(BRANCH), async () => {
      markAcquired();
      await blocked;
    });
    await acquired;

    const pending = run(['lane-input', '--run', runId, '--lane', 'forensic']);
    try {
      const state = await Promise.race([
        pending.then(() => 'completed' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 75)),
      ]);
      expect(state).toBe('waiting');
      expect(await readFile(runFile, 'utf8')).toBe(before);
    } finally {
      release();
      await held;
    }
    expect(await pending).toBe(0);
    expect(await readFile(runFile, 'utf8')).not.toBe(before);
  });

  it('enforces forensic-first ordering, routine caps, one repair, and an honest record', async () => {
    const executionProfile = {
      host: { value: 'test-host', provenance: 'HOST_REPORTED' },
      host_version: { value: '1.2.3', provenance: 'HOST_REPORTED' },
      model: { value: 'test-model', provenance: 'CALLER_DECLARED' },
      effort: null,
      launcher_mode: { value: 'test', provenance: 'EVALUATION_REGISTERED' },
      instruction_hash: null,
    };
    expect(await run(['start', '--execution-profile-json', JSON.stringify(executionProfile)])).toBe(
      0
    );
    const runId = lastJson().run_id as string;
    const started = lastJson();
    expect(started.mode).toBe('routine');

    // Account context is engine-refused before the forensic lane is terminal.
    expect(await run(['lane-input', '--run', runId, '--lane', 'account'])).toBe(1);
    const refusal = lastJson();
    expect(refusal.ok).toBe(false);
    expect((refusal.error as { message: string }).message).toContain('TWOLANE_ROUTINE_ORDER');
    const aFile = await payloadFile('a.json', accountOk());
    expect(await submit(runId, 'account', aFile)).toBe(0);
    const refused = lastJson();
    expect(refused.accepted).toBe(false);
    expect((refused.diagnostics as { code: string }[])[0]!.code).toBe('TWOLANE_ROUTINE_ORDER');

    // The ordering refusal consumed no attempt.
    expect(await run(['run-show', '--run', runId])).toBe(0);
    expect(
      (lastJson().state as { lanes: { account: { attempts: number } } }).lanes.account.attempts
    ).toBe(0);

    // Forensic pass: readable line-oriented payload, contract with caps.
    expect(await run(['lane-input', '--run', runId, '--lane', 'forensic'])).toBe(0);
    const fInput = lastJson();
    expect(fInput.contract).toEqual(LANE_CONTRACTS.forensic);
    const fMd = await readFile(path.join(root, fInput.payload_path as string), 'utf8');
    expect(fMd.startsWith('# Forensic lane input')).toBe(true);
    expect(fMd).toContain('## Diff');
    expect(fMd).toContain('eligible file(s) rendered verbatim');

    // A payload over the routine caps is rejected deterministically.
    const overCap = {
      findings: Array.from({ length: 4 }, (_, i) => ({
        claim: `finding ${i}`,
        file: changedFile(),
        related_files: [],
        severity: 'REVIEW',
        confidence: 'LOW',
      })),
      questions: [],
    };
    const oFile = await payloadFile('o.json', overCap);
    expect(await submit(runId, 'forensic', oFile)).toBe(0);
    const rejected = lastJson();
    expect(rejected.accepted).toBe(false);
    expect(
      (rejected.diagnostics as { code: string }[]).some((d) => d.code === 'SLICE_ROUTINE_LIMITS')
    ).toBe(true);

    // Routine mode allows the forensic repair BEFORE the account initial
    // (parallel-mode ordering rules do not apply; order is engine-owned).
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await submit(runId, 'forensic', fFile)).toBe(0);
    const repaired = lastJson();
    expect(repaired.accepted).toBe(true);
    expect((repaired.state as { repair_credit: { forensic: number } }).repair_credit.forensic).toBe(
      0
    );

    // Account pass serves engine-issued aliases inline beside their records;
    // the canonical lookup stays private to compilation.
    expect(await run(['lane-input', '--run', runId, '--lane', 'account'])).toBe(0);
    const aInput = lastJson();
    expect(aInput.contract).toEqual(LANE_CONTRACTS.account);
    expect((aInput.contract as typeof LANE_CONTRACTS.account).payload_shape).toContain(
      '"overview"'
    );
    expect((aInput.contract as typeof LANE_CONTRACTS.account).overview_shape).toContain('required');
    const aMd = await readFile(path.join(root, aInput.payload_path as string), 'utf8');
    expect(aMd.startsWith('# Account lane input')).toBe(true);
    expect(aMd).not.toContain(`-> ${citationId()}`);
    expect(aMd).not.toContain('## Prompt aliases');
    expect(aMd).toMatch(/#### k1 · a\d+:cp\d+/);
    expect(aMd).toContain('Cite captured records with their inline [c#] aliases');
    expect(aMd).toContain('## Claim ledger');
    expect(aMd).not.toContain('## Changed-file inventory');
    expect(aMd).not.toContain('inventory mode');

    expect(await submit(runId, 'account', aFile)).toBe(0);
    expect(lastJson().accepted).toBe(true);

    expect(await run(['finalize', '--run', runId])).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('FULL');
    // Whether the Part-range round-trip ran is RECORDED rather than assumed.
    // This fixture pins no diff, so it is honestly reported as skipped — which
    // also documents that these lifecycle runs do not cover the validated path;
    // the dedicated test above pins a diff to reach it.
    expect((finalized.run_record as { range_validation: string }).range_validation).toBe(
      'SKIPPED_NO_PINNED_DIFF'
    );
    const record = finalized.run_record as Record<string, unknown>;
    expect(record.mode).toBe('routine');
    expect(record.repairs_used).toBe(1);
    expect(record.submission_count).toBe(3);
    expect((record.isolation as { aggregate: string }).aggregate).toBe('SEQUENTIAL');
    expect((record.usage as { status: string }).status).toBe('UNKNOWN');
    const forensicInput = JSON.parse(
      await readFile(
        path.join(root, '.orcaops', 'reviews', BRANCH, 'forensic-input-v1.json'),
        'utf8'
      )
    ) as ForensicInput;
    expect(record.latency_input_bytes).toBe(Buffer.byteLength(forensicInput.diff, 'utf8'));
    expect(record.latency_tier).toBe('LT_250KB');
    expect(record.latency_budget_ms).toBe(180_000);
    expect(record.latency_status).toBe('PASS');
    expect(record.execution_profile).toEqual(executionProfile);
    expect(record.runtime_identity).toMatchObject({
      packageName: '@orcaops/review-engine',
      compiledRuntimeManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      entrypointSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    // This legacy lifecycle fixture pins neither coverage nor diff. Semantic
    // preparation discloses that absence without blocking the completed review.
    expect((finalized.semantic_anchor as { status: string }).status).toBe('UNAVAILABLE');
    expect((finalized.files as string[]).includes('semantic-anchor-input-v4.json')).toBe(true);

    const runDir = path.join(root, finalized.run_dir as string);
    const markdown = await readFile(path.join(runDir, 'review.md'), 'utf8');
    expect(markdown).toContain('Two-lane review');
    expect(markdown).toContain('lanes: account ✓ forensic ✓');
    expect(finalized.current_story).toMatchObject({ installed: true });
    const pointerFile = path.join(
      root,
      '.orcaops',
      'reviews',
      BRANCH,
      'twolane',
      CURRENT_STORY_POINTER_FILE
    );
    const installedPointer = JSON.parse(await readFile(pointerFile, 'utf8')) as {
      run_id: string;
      model_file: string;
    };
    expect(installedPointer).toMatchObject({
      run_id: runId,
      model_file: 'story-review-model-v4.json',
    });

    // Terminal retry is the crash-window recovery path: it republishes a
    // missing pointer without rewriting the immutable run record.
    await rm(pointerFile);
    expect(await run(['finalize', '--run', runId])).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      status: 'already-finalized',
      run_id: runId,
    });
    expect(JSON.parse(await readFile(pointerFile, 'utf8'))).toMatchObject({ run_id: runId });
  });

  it('rejects a mutating submission from a different executable fingerprint without consuming an attempt', async () => {
    const priorCommit = process.env.ORCAOPS_BUILD_COMMIT;
    try {
      process.env.ORCAOPS_BUILD_COMMIT = 'mint-build';
      const runId = await startRun();
      const fFile = await payloadFile('identity-drift-forensic.json', forensicOk());
      process.env.ORCAOPS_BUILD_COMMIT = 'different-build';
      expect(await submit(runId, 'forensic', fFile)).toBe(1);
      expect((lastJson().error as { message: string }).message).toContain(
        'TWOLANE_EXECUTABLE_IDENTITY_DRIFT'
      );

      process.env.ORCAOPS_BUILD_COMMIT = 'mint-build';
      expect(await run(['run-show', '--run', runId])).toBe(0);
      expect(
        (lastJson().state as { lanes: { forensic: { attempts: number } } }).lanes.forensic.attempts
      ).toBe(0);
    } finally {
      if (priorCommit === undefined) delete process.env.ORCAOPS_BUILD_COMMIT;
      else process.env.ORCAOPS_BUILD_COMMIT = priorCommit;
    }
  });

  it('refuses finalization when the executable changes after both lanes are accepted', async () => {
    const priorCommit = process.env.ORCAOPS_BUILD_COMMIT;
    try {
      process.env.ORCAOPS_BUILD_COMMIT = 'accepted-build';
      const runId = await startRun();
      const fFile = await payloadFile('finalize-identity-forensic.json', forensicOk());
      const aFile = await payloadFile('finalize-identity-account.json', accountOk());
      expect(await submit(runId, 'forensic', fFile)).toBe(0);
      expect(await submit(runId, 'account', aFile)).toBe(0);

      process.env.ORCAOPS_BUILD_COMMIT = 'changed-before-finalize';
      expect(await run(['finalize', '--run', runId])).toBe(1);
      expect((lastJson().error as { message: string }).message).toContain(
        'TWOLANE_EXECUTABLE_IDENTITY_DRIFT'
      );

      process.env.ORCAOPS_BUILD_COMMIT = 'accepted-build';
      expect(await run(['run-show', '--run', runId])).toBe(0);
      expect(lastJson().finalized).toBeNull();
    } finally {
      if (priorCommit === undefined) delete process.env.ORCAOPS_BUILD_COMMIT;
      else process.env.ORCAOPS_BUILD_COMMIT = priorCommit;
    }
  });

  it('rejects malformed or unproven execution-profile metadata before minting a run', async () => {
    expect(
      await run([
        'start',
        '--execution-profile-json',
        JSON.stringify({ model: { value: 'test-model', provenance: 'INFERRED' } }),
      ])
    ).toBe(2);
    expect((lastJson().error as { message: string }).message).toContain(
      '--execution-profile-json is invalid'
    );
  });

  it('routine story caps: too many judgment questions and interpretation overruns are rejected', async () => {
    const runId = await startRun();
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await submit(runId, 'forensic', fFile)).toBe(0);
    expect(lastJson().accepted).toBe(true);

    const tooManyQuestions = { ...accountOk(), questions: ['q1', 'q2', 'q3', 'q4'] };
    expect(await submit(runId, 'account', await payloadFile('q4.json', tooManyQuestions))).toBe(0);
    expect(
      (lastJson().diagnostics as { code: string; message: string }[]).some(
        (d) =>
          d.code === 'SLICE_ROUTINE_LIMITS' && d.message.includes('exceeds the routine ceiling')
      )
    ).toBe(true);

    const story = accountOk();
    story.acts[0]!.parts[0]!.interpretation = Array.from({ length: 81 }, (_, i) => `w${i}`).join(
      ' '
    );
    // The repair credit is still available (one failed account attempt so far).
    expect(await submit(runId, 'account', await payloadFile('long.json', story))).toBe(0);
    const wordRejected = lastJson();
    expect(
      (wordRejected.diagnostics as { code: string; message: string }[]).some(
        (d) => d.code === 'SLICE_ROUTINE_LIMITS' && d.message.includes('81 words')
      )
    ).toBe(true);
    // Credit spent on the failed repair: the lane is now terminal.
    expect(
      (wordRejected.state as { repair_credit: { account: number } }).repair_credit.account
    ).toBe(0);
  });

  it('a full story covering every checkpoint is accepted and finalizes FULL', async () => {
    const runId = await startRun();
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await submit(runId, 'forensic', fFile)).toBe(0);
    const aFile = await payloadFile('story.json', accountOk());
    expect(await submit(runId, 'account', aFile)).toBe(0);
    expect(lastJson().accepted).toBe(true);
    expect(await run(['finalize', '--run', runId])).toBe(0);
    expect(lastJson().outcome).toBe('FULL');
  });

  it('persists normalized authored, compiled, and accepted-envelope lineage without raw bodies', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const accountFile = await payloadFile('account-lineage.json', accountOk());
    const rawBytes = await readFile(accountFile, 'utf8');
    const normalized = normalizeSubmission(rawBytes);
    expect(await submit(runId, 'account', accountFile)).toBe(0);
    expect(lastJson().accepted).toBe(true);
    expect(
      (lastJson().state as { lanes: { account: { outcome: string } } }).lanes.account.outcome
    ).toBe('ACCEPTED_CLEAN_FIRST_PASS');
    expect(await run(['finalize', '--run', runId])).toBe(0);

    const finalized = lastJson();
    const runDir = path.join(root, finalized.run_dir as string);
    const accepted = JSON.parse(
      await readFile(path.join(runDir, 'accepted-account.json'), 'utf8')
    ) as {
      normalization_code: string;
      normalization_codes: string[];
      normalized_authored: unknown;
      compiled_payload: { acts: { id: string }[]; parts: { id: string; title: string }[] };
      inner: {
        raw_submission_sha256: string;
        normalized_authored_sha256: string;
        compiled_payload_sha256: string;
        diagnostic_codes: string[];
      };
    };
    expect(accepted.normalization_code).toBe('CLEAN_JSON');
    expect(accepted.normalization_codes).toEqual(['CLEAN_JSON']);
    expect(accepted.normalized_authored).toEqual(accountOk());
    expect(accepted.compiled_payload.acts[0]!.id).toBe('A1');
    expect(accepted.compiled_payload.parts[0]).toEqual(
      expect.objectContaining({ id: 'P1', title: 'Part 1' })
    );
    expect(accepted.inner).toEqual({
      raw_submission_sha256: normalized.raw_sha256,
      normalized_authored_sha256: normalized.normalized_sha256,
      compiled_payload_sha256: canonicalJsonSha256(accepted.compiled_payload),
      diagnostic_codes: [],
    });
    expect(accepted).not.toHaveProperty('raw_submission');

    const record = finalized.run_record as {
      account_lineage: typeof accepted.inner & {
        accepted_envelope_sha256: string;
        normalization_code: string;
        normalization_codes: string[];
      };
      attempts: Array<Record<string, unknown>>;
    };
    expect(record.account_lineage).toEqual({
      ...accepted.inner,
      accepted_envelope_sha256: canonicalJsonSha256(accepted),
      normalization_code: 'CLEAN_JSON',
      normalization_codes: ['CLEAN_JSON'],
    });
    expect(record.attempts.at(-1)).toEqual(
      expect.objectContaining({
        raw_submission_sha256: normalized.raw_sha256,
        normalized_submission_sha256: normalized.normalized_sha256,
        compiled_payload_sha256: accepted.inner.compiled_payload_sha256,
        accepted_envelope_sha256: canonicalJsonSha256(accepted),
        normalization_codes: ['CLEAN_JSON'],
      })
    );
  });

  it('accepts one JSON-string wrapper as a normalized first pass', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const wrappedFile = path.join(root, 'wrapped-account.json');
    await writeFile(wrappedFile, JSON.stringify(JSON.stringify(accountOk())));
    expect(await submit(runId, 'account', wrappedFile)).toBe(0);
    const submitted = lastJson();
    expect(submitted.accepted).toBe(true);
    expect(
      (submitted.state as { lanes: { account: { outcome: string } } }).lanes.account.outcome
    ).toBe('ACCEPTED_NORMALIZED_FIRST_PASS');

    const runDir = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId);
    const accepted = JSON.parse(
      await readFile(path.join(runDir, 'accepted-account.json'), 'utf8')
    ) as { normalization_code: string; normalization_codes: string[] };
    expect(accepted.normalization_code).toBe('JSON_STRING_UNWRAPPED');
    expect(accepted.normalization_codes).toEqual(['JSON_STRING_UNWRAPPED']);
  });

  it('applies the same one-layer outer normalization to the forensic boundary', async () => {
    const runId = await startRun();
    const wrappedFile = path.join(root, 'wrapped-forensic.json');
    await writeFile(wrappedFile, JSON.stringify(JSON.stringify(forensicOk())));
    expect(await submit(runId, 'forensic', wrappedFile)).toBe(0);
    const submitted = lastJson();
    expect(submitted.accepted).toBe(true);
    expect(
      (submitted.state as { lanes: { forensic: { outcome: string } } }).lanes.forensic.outcome
    ).toBe('ACCEPTED_NORMALIZED_FIRST_PASS');
    const runDir = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId);
    const runFile = JSON.parse(await readFile(path.join(runDir, 'run-v1.json'), 'utf8')) as {
      attempts: Array<{ normalization_code: string; normalization_codes: string[] }>;
    };
    expect(runFile.attempts[0]).toMatchObject({
      normalization_code: 'JSON_STRING_UNWRAPPED',
      normalization_codes: ['JSON_STRING_UNWRAPPED'],
    });
  });

  it('rejects bracketed citations and the removed question key', async () => {
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    const story = accountOk();
    const citation = story.acts[0]!.parts[0]!.citations[0]!;
    story.acts[0]!.parts[0]!.citations = [`[${citation}]`];
    story.questions = [{ question: 'What remains?', citations: [`[${citation}]`] } as never];
    expect(
      await submit(runId, 'account', await payloadFile('historical-account.json', story))
    ).toBe(0);
    expect(lastJson().accepted).toBe(false);
    expect(lastJson().diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLICE_PAYLOAD_SHAPE' })])
    );
    expect(
      (lastJson().state as { lanes: { account: { outcome: string } } }).lanes.account.outcome
    ).toBe('REJECTED_FIRST_PASS');

    const runDir = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId);
    const runFile = JSON.parse(await readFile(path.join(runDir, 'run-v1.json'), 'utf8')) as {
      attempts: Array<{ normalization_code: string; normalization_codes: string[] }>;
    };
    expect(runFile.attempts.at(-1)).toMatchObject({
      normalization_code: 'CLEAN_JSON',
      normalization_codes: ['CLEAN_JSON'],
    });
  });

  it('an account story that leaves a checkpoint unclaimed is rejected with the named diagnostic', async () => {
    const runId = await startRun();
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await submit(runId, 'forensic', fFile)).toBe(0);
    const story = accountOk();
    const incomplete = {
      ...story,
      acts: [{ ...story.acts[0]!, parts: story.acts[0]!.parts.slice(1) }],
    };
    expect(await submit(runId, 'account', await payloadFile('inc.json', incomplete))).toBe(0);
    expect(
      (lastJson().diagnostics as { code: string }[]).some(
        (d) => d.code === 'STORY_CHECKPOINT_UNCLAIMED'
      )
    ).toBe(true);
  });

  it('a rejected forensic initial with a spent credit unlocks the account lane (terminal by exhaustion)', async () => {
    const runId = await startRun();
    const garbled = path.join(root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    expect(await submit(runId, 'forensic', garbled)).toBe(0);
    expect(lastJson().accepted).toBe(false);
    // Repair attempt also fails: credit spent, forensic terminal.
    expect(await submit(runId, 'forensic', garbled)).toBe(0);
    expect(lastJson().accepted).toBe(false);
    expect(await run(['run-show', '--run', runId])).toBe(0);
    expect(lastJson().forensic_terminal).toBe(true);
    const aFile = await payloadFile('a.json', accountOk());
    expect(await submit(runId, 'account', aFile)).toBe(0);
    expect(lastJson().accepted).toBe(true);
    expect(await run(['finalize', '--run', runId])).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('DEGRADED');
    expect((finalized.run_record as { repairs_used: number }).repairs_used).toBe(1);
  });

  it('refuses required-flag omissions with parseable envelopes (no env gate)', async () => {
    const runId = await startRun();
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await run(['lane-submit', '--run', runId, '--lane', 'forensic', '--input', fFile])).toBe(
      2
    );
    expect((lastJson().error as { message: string }).message).toContain('--isolation');
    // Two-lane is the default: start succeeds with no environment
    // incantation (the retired gate returned exit 2 here).
    expect(await run(['start'])).toBe(0);
  });

  it('types unfinished flat-authoring runs as unsupported instead of reinterpreting v4 state', async () => {
    const runId = await startRun();
    const runFile = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId, 'run-v1.json');
    const historical = JSON.parse(await readFile(runFile, 'utf8')) as {
      slice_state: { schema_version: number };
    };
    historical.slice_state.schema_version = 4;
    await writeFile(runFile, JSON.stringify(historical));

    expect(await run(['run-show', '--run', runId])).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain(
      'slice schema 4 is unsupported by current schema 5'
    );
  });

  it('types a pre-cut schema_version-1 run file as version-unsupported, not shape issues', async () => {
    const runId = await startRun();
    const runFile = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId, 'run-v1.json');
    const persisted = JSON.parse(await readFile(runFile, 'utf8')) as { schema_version: number };
    persisted.schema_version = 1;
    await writeFile(runFile, JSON.stringify(persisted));

    expect(await run(['run-show', '--run', runId])).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain(
      'run schema 1 is unsupported by current schema 2'
    );
  });

  it('types a truncated run file as a contract violation, not a bare SyntaxError', async () => {
    const runId = await startRun();
    const runFile = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId, 'run-v1.json');
    const persisted = await readFile(runFile, 'utf8');
    await writeFile(runFile, persisted.slice(0, Math.floor(persisted.length / 2)));

    expect(await run(['run-show', '--run', runId])).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain('is not valid JSON');
  });

  it('rejects a persisted run file missing runtime_identity instead of defaulting it', async () => {
    const runId = await startRun();
    const runFile = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId, 'run-v1.json');
    const persisted = JSON.parse(await readFile(runFile, 'utf8')) as Record<string, unknown>;
    delete persisted.runtime_identity;
    await writeFile(runFile, JSON.stringify(persisted));

    expect(await run(['run-show', '--run', runId])).toBe(1);
    const message = (lastJson().error as { message: string }).message;
    expect(message).toContain('violates the persisted run schema');
    expect(message).toContain('runtime_identity');
  });

  it('requires current runtime identity hashes while allowing a null entrypoint hash', async () => {
    for (const field of [
      'entrypointSha256',
      'compiledRuntimeManifestSha256',
      'runtimeFingerprintSha256',
    ]) {
      const runId = await startRun();
      const runFile = path.join(
        root,
        '.orcaops',
        'reviews',
        BRANCH,
        'twolane',
        runId,
        'run-v1.json'
      );
      const persisted = JSON.parse(await readFile(runFile, 'utf8')) as {
        runtime_identity: Record<string, unknown>;
      };
      delete persisted.runtime_identity[field];
      await writeFile(runFile, JSON.stringify(persisted));

      expect(await run(['run-show', '--run', runId])).toBe(1);
      expect((lastJson().error as { message: string }).message).toContain(
        `runtime_identity.${field}`
      );
    }

    const runId = await startRun();
    const runFile = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId, 'run-v1.json');
    const persisted = JSON.parse(await readFile(runFile, 'utf8')) as {
      runtime_identity: Record<string, unknown>;
    };
    persisted.runtime_identity.entrypointSha256 = null;
    await writeFile(runFile, JSON.stringify(persisted));
    expect(await run(['run-show', '--run', runId])).toBe(0);
  });

  it('rejects a persisted execution profile missing a component key instead of defaulting it', async () => {
    const runId = await startRun();
    const runFile = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId, 'run-v1.json');
    const persisted = JSON.parse(await readFile(runFile, 'utf8')) as {
      execution_profile: Record<string, unknown>;
    };
    delete persisted.execution_profile.host;
    await writeFile(runFile, JSON.stringify(persisted));

    expect(await run(['run-show', '--run', runId])).toBe(1);
    const message = (lastJson().error as { message: string }).message;
    expect(message).toContain('violates the persisted run schema');
    expect(message).toContain('execution_profile.host');
  });
});

describe('routine-surface json failure envelopes', () => {
  it('routine-start returns the underlying cause in an envelope under --json', async () => {
    // The temp root is not a git repository, so floor assembly throws — the
    // composite must answer with a parseable envelope, not a bare stderr line.
    const code = await runReview(
      ['review', 'routine-start', '--branch', BRANCH, '--root', root, '--json'],
      process.env
    );
    expect(code).toBe(1);
    const envelope = lastJson();
    expect(envelope.ok).toBe(false);
    const failure = envelope.error as { verb: string; message: string };
    expect(failure.verb).toBe('review routine-start');
    expect(failure.message.length).toBeGreaterThan(0);
  });

  it('routine-start keeps the human stderr line without --json', async () => {
    const code = await runReview(
      ['review', 'routine-start', '--branch', BRANCH, '--root', root],
      process.env
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('review routine-start:');
    expect(out.filter((line) => line.trim().startsWith('{'))).toEqual([]);
  });

  it('missing --branch on routine-start is enveloped under --json', async () => {
    const code = await runReview(
      ['review', 'routine-start', '--root', root, '--json'],
      process.env
    );
    expect(code).toBe(2);
    expect((lastJson().error as { message: string }).message).toContain('--branch is required');
  });

  it('routine-submit failures are enveloped under --json', async () => {
    const fFile = await payloadFile('f.json', forensicOk());
    const code = await run([
      'routine-submit',
      '--run',
      'no-such-run',
      '--lane',
      'forensic',
      '--isolation',
      'sequential',
      '--input',
      fFile,
    ]);
    expect(code).toBe(1);
    const envelope = lastJson();
    expect(envelope.ok).toBe(false);
    expect((envelope.error as { verb: string }).verb).toBe('review routine-submit');
    expect((envelope.error as { message: string }).message).toContain('not readable');
  });
});

describe('composite routine verbs', () => {
  const compositeStart = async (): Promise<Record<string, unknown>> => {
    const code = await runTwolaneRun(
      { cmd: 'review', sub: 'routine-start', branch: BRANCH, json: true },
      root
    );
    expect(code).toBe(0);
    return lastJson();
  };
  const compositeSubmit = (runId: string, lane: string, file: string) =>
    run([
      'routine-submit',
      '--run',
      runId,
      '--lane',
      lane,
      '--isolation',
      'sequential',
      '--input',
      file,
    ]);

  it('routine-start mints the run and serves the forensic input in one envelope', async () => {
    const env = await compositeStart();
    expect(Object.keys(env).sort()).toEqual([
      'branch',
      'contract',
      'input_shas',
      'lane',
      'mode',
      'ok',
      'payload_bytes',
      'payload_path',
      'payload_sha',
      'run_dir',
      'run_id',
    ]);
    expect(env.mode).toBe('routine');
    expect(env.lane).toBe('forensic');
    expect(env.contract).toEqual(LANE_CONTRACTS.forensic);
    const md = await readFile(path.join(root, env.payload_path as string), 'utf8');
    expect(md.startsWith('# Forensic lane input')).toBe(true);
  });

  it('refuses to mint through a symlinked run directory', async () => {
    const external = path.join(root, 'external-runs');
    await mkdir(external);
    await symlink(external, path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane'), 'dir');

    expect(
      await runTwolaneRun({ cmd: 'review', sub: 'routine-start', branch: BRANCH, json: true }, root)
    ).toBe(1);
    await expect(readdir(external)).resolves.toEqual([]);
  });

  it('forensic acceptance serves the account input; account acceptance auto-finalizes', async () => {
    const started = await compositeStart();
    const runId = started.run_id as string;
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await compositeSubmit(runId, 'forensic', fFile)).toBe(0);
    const fEnv = lastJson();
    expect(fEnv.accepted).toBe(true);
    const account = fEnv.account as Record<string, unknown>;
    expect(account.contract).toEqual(LANE_CONTRACTS.account);
    const aMd = await readFile(path.join(root, account.payload_path as string), 'utf8');
    expect(aMd.startsWith('# Account lane input')).toBe(true);

    const storyFile = await payloadFile('story.json', accountOk());
    expect(await compositeSubmit(runId, 'account', storyFile)).toBe(0);
    const aEnv = lastJson();
    expect(aEnv.accepted).toBe(true);
    expect(aEnv.outcome).toBe('FULL');
    expect((aEnv.files as string[]).includes('review.md')).toBe(true);
    expect((aEnv.run_record as { mode: string }).mode).toBe('routine');
    expect(aEnv.ownership_summary).toEqual(
      (aEnv.run_record as { ownership_summary: unknown }).ownership_summary
    );
    const review = await readFile(path.join(root, aEnv.run_dir as string, 'review.md'), 'utf8');
    expect(review).toContain('Two-lane review');
  });

  it('prepares a complete semantic-anchor input at finalization and returns its receipt', async () => {
    // This old fixture predates parent-aware alternative projection and repeats
    // one alternative under every decision in a checkpoint. Fresh production
    // projections do not. Normalize that legacy shape so this test exercises
    // the current finalization contract rather than compatibility corruption.
    const currentProjection = projectionFix();
    for (const checkpoint of currentProjection.accountCore.checkpoints) {
      const seen = new Set<string>();
      for (const decision of checkpoint.decisions) {
        decision.alternatives = decision.alternatives.filter((alternative) => {
          if (seen.has(alternative.citationId)) return false;
          seen.add(alternative.citationId);
          return true;
        });
      }
    }
    const firstCheckpoint = currentProjection.accountCore.checkpoints[0]!;
    const artifact = currentProjection.artifactAliases[firstCheckpoint.artifact]!;
    const reviewDir = path.join(root, '.orcaops', 'reviews', BRANCH);
    const semanticDiff =
      'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
    await writeFile(
      path.join(reviewDir, 'account-projection-v1.json'),
      JSON.stringify(currentProjection)
    );
    await writeFile(path.join(reviewDir, 'diff.patch'), semanticDiff);
    const forensicInput = JSON.parse(
      await readFile(path.join(reviewDir, 'forensic-input-v1.json'), 'utf8')
    ) as Record<string, unknown> & { metrics: Record<string, unknown> };
    forensicInput.diff = semanticDiff;
    forensicInput.excludedPaths = [];
    forensicInput.unreviewablePaths = [];
    forensicInput.policyStubs = [];
    forensicInput.metrics = {
      ...forensicInput.metrics,
      eligibleFiles: 1,
      excludedFiles: 0,
      unreviewableFiles: 0,
      policyStubFiles: 0,
      policyStubRows: 0,
      policyStubBytes: 0,
      eligibleDiffBytes: Buffer.byteLength(semanticDiff),
    };
    await writeFile(path.join(reviewDir, 'forensic-input-v1.json'), JSON.stringify(forensicInput));
    await writeFile(
      path.join(reviewDir, 'coverage-v1.json'),
      JSON.stringify({
        items: [
          {
            hunkKey: 'hunk_semantic_ready',
            file: 'src/x.ts',
            verdict: 'MATCHED',
            old_start: 1,
            new_start: 1,
            added_lines: 1,
            removed_lines: 1,
            units: [
              {
                kind: 'owned_slice',
                slice: 0,
                patch_row_start: 0,
                patch_row_end: 1,
                del_range: { start: 1, end: 1 },
                add_range: { start: 1, end: 1 },
                lines: 2,
                owner: { kind: 'checkpoint', artifact, cp: firstCheckpoint.cp },
              },
            ],
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
      })
    );

    const runId = (await compositeStart()).run_id as string;
    expect(
      await compositeSubmit(runId, 'forensic', await payloadFile('f.json', forensicOk()))
    ).toBe(0);
    expect(
      await compositeSubmit(runId, 'account', await payloadFile('story.json', accountOk()))
    ).toBe(0);
    const final = lastJson();
    const prepared = final.semantic_anchor as Record<string, unknown>;
    expect(prepared.status, JSON.stringify(prepared)).toBe('READY');
    expect(prepared.payload_path).toEqual(expect.stringContaining('semantic-anchor-input-v4.md'));
    expect(prepared.receipt_path).toEqual(expect.stringContaining('semantic-anchor-input-v4.json'));
    expect(prepared.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    const payload = await readFile(path.join(root, prepared.payload_path as string), 'utf8');
    expect(payload).toContain('@@@ change-hunk:h1 MODIFICATION @@@');
    expect(payload).toContain('@@@ change-block:h1.b1 REPLACEMENT old:1:1 new:1:1 @@@');
    expect(payload).toContain('-D1 old');
    expect(payload).toContain('+A1 new');
    expect(payload).not.toContain('@@@ change-row:');
    expect(payload).toContain(citationId());
    const receipt = JSON.parse(
      await readFile(path.join(root, prepared.receipt_path as string), 'utf8')
    ) as { run_id: string; status: string; profile: string; profile_source: string };
    expect(receipt.run_id).toBe(runId);
    expect(receipt.status).toBe('READY');
    expect(receipt.profile).toBe('semantic-anchor-profile-v1');
    expect(receipt.profile_source).toBe('ENGINE_REGISTERED');
    expect((final.files as string[]).sort()).toContain('semantic-anchor-input-v4.md');
  });

  it('a rejection returns diagnostics and the same command accepts the repaired payload', async () => {
    const started = await compositeStart();
    const runId = started.run_id as string;
    const garbled = path.join(root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    expect(await compositeSubmit(runId, 'forensic', garbled)).toBe(0);
    const rejected = lastJson();
    expect(rejected.accepted).toBe(false);
    expect(rejected.account).toBeUndefined();
    expect((rejected.diagnostics as { code: string }[])[0]!.code).toBe('SLICE_PAYLOAD_SHAPE');
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await compositeSubmit(runId, 'forensic', fFile)).toBe(0);
    const repaired = lastJson();
    expect(repaired.accepted).toBe(true);
    expect((repaired.state as { repair_credit: { forensic: number } }).repair_credit.forensic).toBe(
      0
    );
    expect(repaired.account).toBeDefined();
  });

  it('the composite refuses a premature account submission (ordering intact)', async () => {
    const started = await compositeStart();
    const runId = started.run_id as string;
    const aFile = await payloadFile('a.json', accountOk());
    expect(await compositeSubmit(runId, 'account', aFile)).toBe(0);
    const refused = lastJson();
    expect(refused.accepted).toBe(false);
    expect((refused.diagnostics as { code: string }[])[0]!.code).toBe('TWOLANE_ROUTINE_ORDER');
  });

  it('chains on terminality: an exhausted forensic lane still serves account; an exhausted account lane finalizes', async () => {
    const started = await compositeStart();
    const runId = started.run_id as string;
    const garbled = path.join(root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    // Forensic initial rejected: not yet terminal (repair remains), no chain.
    expect(await compositeSubmit(runId, 'forensic', garbled)).toBe(0);
    expect(lastJson().account).toBeUndefined();
    // Forensic repair also rejected: credit spent, lane terminal — the
    // response STILL serves the account input (the reviewer is not stranded).
    expect(await compositeSubmit(runId, 'forensic', garbled)).toBe(0);
    const exhausted = lastJson();
    expect(exhausted.accepted).toBe(false);
    expect((exhausted.account as Record<string, unknown>).payload_path).toBeDefined();
    // Account has its own repair. The initial rejection remains nonterminal;
    // its second rejection spends that lane's credit and finalizes honestly.
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    expect(lastJson().outcome).toBeUndefined();
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    const finalized = lastJson();
    expect(finalized.accepted).toBe(false);
    expect(finalized.outcome).toBe('FAILED');
    expect(finalized.ownership_summary).toBeNull();
    expect((finalized.run_record as { ownership_summary: unknown }).ownership_summary).toBeNull();
    const persisted = JSON.parse(
      await readFile(path.join(root, finalized.run_dir as string, 'run-record-v1.json'), 'utf8')
    ) as { ownership_summary: unknown };
    expect(persisted.ownership_summary).toBeNull();
    await expect(
      readFile(
        path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', CURRENT_STORY_POINTER_FILE),
        'utf8'
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('chains DEGRADED when only the account lane exhausts its repair', async () => {
    const started = await compositeStart();
    const runId = started.run_id as string;
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await compositeSubmit(runId, 'forensic', fFile)).toBe(0);
    const garbled = path.join(root, 'garbled.json');
    await writeFile(garbled, 'not json {');
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    expect(lastJson().outcome).toBeUndefined();
    expect(await compositeSubmit(runId, 'account', garbled)).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('DEGRADED');
    expect((finalized.run_record as { repairs_used: number }).repairs_used).toBe(1);
  });

  it('every inline c# is engine-mapped without publishing the canonical lookup', async () => {
    const runId = (await compositeStart()).run_id as string;
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await compositeSubmit(runId, 'forensic', fFile)).toBe(0);
    const account = lastJson().account as Record<string, unknown>;
    const md = await readFile(path.join(root, account.payload_path as string), 'utf8');
    expect(md).not.toMatch(/^ {2}citations: /m);
    const aliases = [...md.matchAll(/\[(c\d+)\]/g)].map((match) => match[1]!);
    expect(aliases.length).toBeGreaterThan(0);
    const projection = projectionFix();
    const mapping = new Map(
      buildAccountPromptAliases(projection).citations.map((entry) => [entry.alias, entry.canonical])
    );
    const citable = accountCitableIds(projection);
    expect(md).not.toMatch(/^- c\d+ -> /m);
    for (const alias of new Set(aliases)) {
      const canonical = mapping.get(alias);
      expect(canonical, `unmapped bracketed alias ${alias}`).toBeDefined();
      expect(citable.has(canonical!), `non-citable mapped id ${canonical}`).toBe(true);
    }
  });

  it('unknown --profile values fail loudly', async () => {
    expect(await run(['dossier', '--profile', 'routin'])).toBe(2);
    expect(err.join('')).toContain("unknown --profile 'routin'");
  });

  // REGRESSION: a composition failure
  // AFTER the account lane accepted surfaced as a routine-submit error; the
  // reviewer resubmitted and burned SLICE_SUBMIT_AFTER_ACCEPT. Post-acceptance
  // engine failures must report as a finalize-stage envelope with acceptance
  // explicit, and `finalize` must stay retryable.
  it('a post-acceptance composition failure reports its SPECIFIC code, never a submit rejection', async () => {
    // An inconsistent pinned coverage snapshot (summary claims 2 matched rows,
    // units carry 1) makes the exactly-once fold throw only at composition.
    const uuid = projectionFix().artifactAliases['a1']!;
    await writeFile(
      path.join(root, '.orcaops', 'reviews', BRANCH, 'coverage-v1.json'),
      JSON.stringify({
        items: [
          {
            file: 'src/x.ts',
            hunkKey: 'hk1',
            units: [
              {
                kind: 'owned_slice',
                slice: 0,
                patch_row_start: 1,
                patch_row_end: 1,
                del_range: null,
                add_range: { start: 1, end: 1 },
                lines: 1,
                owner: { kind: 'checkpoint', artifact: uuid, cp: 1 },
              },
            ],
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
      })
    );
    const runId = (await compositeStart()).run_id as string;
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await compositeSubmit(runId, 'forensic', fFile)).toBe(0);
    const aFile = await payloadFile('a.json', accountOk());
    expect(await compositeSubmit(runId, 'account', aFile)).toBe(0);
    const envelope = lastJson();
    expect(envelope.ok).toBe(true);
    expect(envelope.accepted).toBe(true);
    expect(envelope.outcome).toBeUndefined();
    const fe = envelope.finalize_error as {
      code: string;
      lane_accepted: boolean;
      run_finalized: boolean;
      retry: string;
    };
    // Not the generic STORY_COMPOSE_FAILED: this is the exactly-once ownership
    // fold failing, and the code says which thing to go look at.
    expect(fe.code).toBe('PART_OWNERSHIP_INVARIANT');
    expect(fe.lane_accepted).toBe(true);
    expect(fe.run_finalized).toBe(false);
    expect(fe.retry).toContain('finalize');
    // The plain finalize verb surfaces the same code and stays retryable.
    expect(await run(['finalize', '--run', runId])).toBe(1);
    expect((lastJson().error as { message: string }).message).toContain('PART_OWNERSHIP_INVARIANT');
    // The run is NOT finalized and NOT sealed: run-show reflects both lanes
    // accepted with the run still open.
    expect(await run(['run-show', '--run', runId])).toBe(0);
    const shown = lastJson();
    expect(shown.finalized).toBeNull();
    const shownState = shown.state as { lanes: Record<string, { accepted: boolean }> };
    expect(shownState.lanes.account.accepted).toBe(true);
  });

  it('the PRODUCTION mint serves a complete facts block — no placeholders, no omissions', async () => {
    // The point of this test is that "optional" means optional-for-tests only.
    // An optional argument silently becoming an absent one in the only path
    // that matters is exactly how the stale-claim defect would survive the fix,
    // so this asserts the bytes the real routine-start writes to disk.
    const runId = (await compositeStart()).run_id as string;
    const runDir = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId);
    const served = await readFile(path.join(runDir, 'lane-account.md'), 'utf8');

    expect(served).toContain('## THIS RUN (executing now — not captured history)');
    expect(served).toContain(`run: ${runId}`);
    expect(served).toContain('executing now');
    expect(served).toContain('latency tier in force for this run:');
    expect(served).toMatch(/floor \S{8,}/);
    expect(served).toMatch(/diff under review: \d+ eligible file\(s\), \d+ bytes/);
    // The instruction that makes the block actionable, not just present.
    expect(served).toContain('check it against these facts before repeating it');

    // No placeholder leaked into any fact line.
    const factLines = served.split('\n').slice(
      served.split('\n').findIndex((l) => l.startsWith('## THIS RUN')),
      served.split('\n').findIndex((l) => l.startsWith('## Artifact '))
    );
    for (const bad of ['undefined', 'NaN', 'null', 'TODO', '{']) {
      expect(factLines.join('\n')).not.toContain(bad);
    }
  });

  it('a validation failure leaves NO review.md or brief.json behind', async () => {
    // The test above fails in composeStory, BEFORE any write — so it does not
    // cover validate-before-write. This one fails at validation: were validation
    // to run last, inside the story-model write call, review.md, brief.json and
    // the composed story would already be on disk, so a run reporting "not
    // finalized" would leave a usable-looking review beside it.
    // NOTE: the rest of this suite pins NO diff, so it has never exercised
    // Part-range validation — every other run records
    // range_validation: SKIPPED_NO_PINNED_DIFF. This test pins one so the
    // validated path is reached at all.
    await writeFile(
      path.join(root, '.orcaops', 'reviews', BRANCH, 'diff.patch'),
      'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n'
    );
    const runId = (await compositeStart()).run_id as string;
    const runDir = path.join(root, '.orcaops', 'reviews', BRANCH, 'twolane', runId);
    // The diff IS pinned (input_shas.diff is set), then goes missing. That is
    // the case the old code swallowed to null, silently skipping validation.
    await rm(path.join(runDir, 'diff.patch'), { force: true });

    const fFile = await payloadFile('f.json', forensicOk());
    expect(await compositeSubmit(runId, 'forensic', fFile)).toBe(0);
    const aFile = await payloadFile('a.json', accountOk());
    expect(await compositeSubmit(runId, 'account', aFile)).toBe(0);

    const fe = lastJson().finalize_error as { code: string; run_finalized: boolean };
    expect(fe.code).toBe('PINNED_DIFF_UNREADABLE');
    expect(fe.run_finalized).toBe(false);

    // Asserted ON DISK, not from the response envelope: the envelope said "not
    // finalized" before this change too, while the files were sitting there.
    for (const name of ['review.md', 'brief.json', 'composed-story-v2.json']) {
      await expect(readFile(path.join(runDir, name), 'utf8')).rejects.toThrow();
    }
  });
});

describe('frozen latency tiers', () => {
  it('tiers come from the frozen amendment, boundaries included', () => {
    expect(latencyTierFor(0)).toContain('180s');
    expect(latencyTierFor(249_999)).toContain('180s');
    expect(latencyTierFor(250_000)).toContain('300s');
    expect(latencyTierFor(999_999)).toContain('300s');
    expect(latencyTierFor(1_000_000)).toContain('480s');
    expect(latencyTierFor(1_110_238)).toContain('480s');
    expect(latencyProfileFor(2_000_000)).toEqual({
      latency_input_bytes: 2_000_000,
      latency_tier: 'FROM_1MB_TO_2MB',
      latency_budget_ms: 480_000,
    });
    expect(() => latencyProfileFor(2_000_001)).toThrow('transport ceiling');
  });
});

describe('instruction-ownership boundary', () => {
  it('public usage carries no retired gate vocabulary', () => {
    expect(REVIEW_USAGE).not.toContain('flag-gated');
    expect(REVIEW_USAGE).not.toContain('ORCAOPS_TWOLANE');
  });

  it('all constant prose the lifecycle emits is pinned to the reviewed fixture', () => {
    const pinned = JSON.parse(readFileSync(CONSTANTS_FIX, 'utf8')) as Record<string, unknown>;
    expect({
      lane_contracts: LANE_CONTRACTS,
      routine_order_message: ROUTINE_ORDER_MESSAGE,
    }).toEqual(pinned);
  });

  it('lane-input envelopes expose no free-prose channel', async () => {
    const runId = await startRun();
    expect(await run(['lane-input', '--run', runId, '--lane', 'forensic'])).toBe(0);
    const envelope = lastJson();
    const nonContract = Object.entries(envelope).filter(([k]) => k !== 'contract');
    for (const [key, value] of nonContract) {
      expect(['ok', 'run_id', 'lane', 'payload_path', 'payload_sha', 'payload_bytes']).toContain(
        key
      );
      if (typeof value === 'string') expect(value.includes(' ')).toBe(false);
    }
  });

  it('the production path and the canonical skill invoke no model directly or by proxy', () => {
    const productionSources = [
      'twolaneRunCli.ts',
      'twolaneSlice.ts',
      'dossier.ts',
      'dossierCli.ts',
      'run.ts',
      'semanticAnchors.ts',
      'semanticAnchorCli.ts',
      'semanticAnchorGenerations.ts',
    ].map((f) => path.join(__dirname, f));
    const skillTemplate = path.join(
      __dirname,
      '..',
      '..',
      'adapters',
      'src',
      'skills',
      'orcaops-task-review.ts'
    );
    const banned = [
      '@orcaops/llm',
      'packages/llm',
      'LLMClient',
      'claude -p',
      'codex exec',
      '@anthropic-ai/',
      'openai',
    ];
    for (const file of [...productionSources, skillTemplate]) {
      const source = readFileSync(file, 'utf8');
      for (const token of banned)
        expect(source.includes(token), `${file} contains ${token}`).toBe(false);
    }
    // The harness module (evaluator infrastructure) stays out of the production path.
    for (const file of productionSources) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('./evalHarness'), `${file} imports evalHarness`).toBe(false);
    }
  });
});

describe('composition ownership labels at finalize', () => {
  it('stores and mirrors full-precision DERIVED ownership metrics from composed output', async () => {
    await installDerivedOwnershipFixture(4);
    const runId = await startRun();
    expect(await submit(runId, 'forensic', await payloadFile('f.json', forensicOk()))).toBe(0);
    expect(await submit(runId, 'account', await payloadFile('a.json', accountOk()))).toBe(0);
    expect(await run(['finalize', '--run', runId])).toBe(0);
    const finalized = lastJson();
    const expected = {
      label: 'DERIVED',
      reviewable_rows: 3,
      attributed_rows: 1,
      attributed_pct: (1 / 3) * 100,
      ambiguous_rows: 0,
      contested_rows: 0,
      unattributed_rows: 2,
      missing_boundary_checkpoints: 4,
    };
    expect(finalized.ownership_summary).toEqual(expected);
    const record = finalized.run_record as {
      ownership_summary: typeof expected;
      outputs: { ownership_label: string };
    };
    expect(record.ownership_summary).toEqual(expected);
    expect(record.ownership_summary.attributed_pct).toBe((1 / 3) * 100);
    expect(record.outputs.ownership_label).toBe('DERIVED');

    const persisted = JSON.parse(
      await readFile(path.join(root, finalized.run_dir as string, 'run-record-v1.json'), 'utf8')
    ) as typeof record;
    expect(persisted.ownership_summary).toEqual(expected);
    expect(persisted.outputs.ownership_label).toBe('DERIVED');
  });

  it('finalizes DEGRADED_ATTRIBUTION when the coverage snapshot is absent (story retained)', async () => {
    // The fixtures written to reviewDir carry no coverage-v1.json, so the run
    // pins no coverage and the composition retains the story but cannot derive
    // ownership — a labeled degraded state distinct from code-only.
    const runId = await startRun();
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await submit(runId, 'forensic', fFile)).toBe(0);
    const aFile = await payloadFile('a.json', accountOk());
    expect(await submit(runId, 'account', aFile)).toBe(0);
    expect(await run(['finalize', '--run', runId])).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('FULL');
    const expectedOwnership = {
      label: 'DEGRADED_ATTRIBUTION',
      reviewable_rows: 0,
      attributed_rows: 0,
      attributed_pct: 0,
      ambiguous_rows: 0,
      contested_rows: 0,
      unattributed_rows: 0,
      missing_boundary_checkpoints: dossierFix().missing_boundary_checkpoints,
    };
    expect(finalized.ownership_summary).toEqual(expectedOwnership);
    expect((finalized.run_record as { ownership_summary: unknown }).ownership_summary).toEqual(
      expectedOwnership
    );
    const runDir = path.join(root, finalized.run_dir as string);
    const brief = JSON.parse(await readFile(path.join(runDir, 'brief.json'), 'utf8')) as {
      ownership: { label: string };
    };
    expect(brief.ownership.label).toBe('DEGRADED_ATTRIBUTION');
    const composed = JSON.parse(
      await readFile(path.join(runDir, 'composed-story-v2.json'), 'utf8')
    ) as { story: unknown; ownership: { label: string } };
    expect(composed.story).not.toBeNull();
    expect(composed.ownership.label).toBe('DEGRADED_ATTRIBUTION');
    expect(
      (finalized.run_record as { outputs: { ownership_label: string } }).outputs.ownership_label
    ).toBe('DEGRADED_ATTRIBUTION');
    const md = await readFile(path.join(runDir, 'review.md'), 'utf8');
    expect(md).toContain('DEGRADED OWNERSHIP');

    // The canonical Story review model is the run's PRIMARY output — installed
    // beside the run dir, schema-valid, with the authored Story retained and all
    // Parts context-only (attribution unusable → every Part owns zero segments).
    expect((finalized.files as string[]).includes('story-review-model-v4.json')).toBe(true);
    const model = parseStoryReviewModel(
      JSON.parse(await readFile(path.join(runDir, 'story-review-model-v4.json'), 'utf8'))
    );
    expect(model.label).toBe('DEGRADED_ATTRIBUTION');
    expect(model.parts.length).toBeGreaterThan(0);
    expect(model.parts.every((p) => p.contextOnly)).toBe(true);
  });

  it('finalizes CODE_ONLY when no account story is accepted (forensic-only)', async () => {
    const runId = await startRun();
    const fFile = await payloadFile('f.json', forensicOk());
    expect(await submit(runId, 'forensic', fFile)).toBe(0);
    // No account submission → forensic-only: DEGRADED outcome, CODE_ONLY ownership.
    expect(await run(['finalize', '--run', runId])).toBe(0);
    const finalized = lastJson();
    expect(finalized.outcome).toBe('DEGRADED');
    const runDir = path.join(root, finalized.run_dir as string);
    const brief = JSON.parse(await readFile(path.join(runDir, 'brief.json'), 'utf8')) as {
      ownership: { label: string };
    };
    expect(brief.ownership.label).toBe('CODE_ONLY');
    const md = await readFile(path.join(runDir, 'review.md'), 'utf8');
    expect(md).toContain('CODE-ONLY');
  });

  it('retains every ownership partition and rejects an incomplete row equation', () => {
    const composed = {
      ownership: {
        label: 'DERIVED',
        missingBoundaryCheckpoints: 2,
        metrics: {
          reviewableRows: 18,
          attributedRows: 9,
          attributedPct: 50,
          ambiguousRows: 2,
          contestedRows: 3,
          unattributedRows: 4,
          contributingThreads: 3,
          contributingCheckpoints: 4,
        },
      },
    } as Parameters<typeof ownershipSummaryFromComposed>[0];
    expect(ownershipSummaryFromComposed(composed)).toEqual({
      label: 'DERIVED',
      reviewable_rows: 18,
      attributed_rows: 9,
      attributed_pct: 50,
      ambiguous_rows: 2,
      contested_rows: 3,
      unattributed_rows: 4,
      missing_boundary_checkpoints: 2,
    });
    expect(() =>
      ownershipSummaryFromComposed({
        ...composed,
        ownership: {
          ...composed.ownership,
          metrics: { ...composed.ownership.metrics, reviewableRows: 19 },
        },
      })
    ).toThrow(/ownership summary partition mismatch/);
  });
});

describe('renderForensicRoutineMd — policy-stub accounting', () => {
  const base = (over: Partial<ForensicInput> = {}): ForensicInput => ({
    schema_version: 2,
    baseSha: 'deadbeef',
    diff: 'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+b',
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
      eligibleDiffBytes: 40,
    },
    ...over,
  });

  it('renders the loud stub lines and the coverage stub count', () => {
    const md = renderForensicRoutineMd(
      base({
        policyStubs: [
          {
            path: 'fixtures/corpus.jsonl',
            adds: 900,
            dels: 3,
            bytes: 500000,
            reason: 'review.stub_paths',
          },
        ],
        metrics: {
          eligibleFiles: 1,
          excludedFiles: 0,
          unreviewableFiles: 0,
          policyStubFiles: 1,
          policyStubRows: 903,
          policyStubBytes: 500000,
          eligibleDiffBytes: 40,
        },
      })
    );
    expect(md).toContain('· 1 policy-stubbed');
    expect(md).toContain(
      'policy-stubbed (review.stub_paths, NOT in diff, 903 row(s) / 500000 bytes'
    );
    expect(md).toContain(
      'stub fixtures/corpus.jsonl — +900/-3 rows, 500000 bytes [review.stub_paths]'
    );
  });

  it('is defensive against a payload pinned before stub_paths existed', () => {
    const legacy = {
      schema_version: 2,
      baseSha: 'x',
      diff: 'd',
      excludedPaths: [],
      unreviewablePaths: [],
      metrics: {
        eligibleFiles: 1,
        excludedFiles: 0,
        unreviewableFiles: 0,
        eligibleDiffBytes: 1,
      },
    } as unknown as ForensicInput;
    const md = renderForensicRoutineMd(legacy);
    expect(md).toContain('0 policy-stubbed');
    expect(md).not.toContain('stub ');
  });
});
