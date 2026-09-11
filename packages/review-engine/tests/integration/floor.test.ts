import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildDiffFingerprintManifest,
  captureCheckpointSnapshot,
  diffSnapshotTrees,
  Repo,
} from '@orcaops/core';
import { COVERAGE_VERDICT, DISCLOSURE_CODE, slugifyBranch } from '@orcaops/review-core';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { buildFloor } from '../../src/floor.js';
import { runGit } from '../../src/git.js';
import type { ReviewArtifact, ReviewCheckpoint } from '../../src/model.js';
import type { ScopeInputs } from '../../src/scope.js';

const BRANCH = 'feat/fixture';
const ARTIFACT = 'fixt-e2e-0001';
const NOW = '2026-03-01T00:00:00.000Z';
const PINNED_DATE = '2026-01-02T03:04:05Z';
const STEP_1 = '01HXFIX0000000000000STEP1';
const STEP_2 = '01HXFIX0000000000000STEP2';
const STEP_3 = '01HXFIX0000000000000STEP3';
const CRIT_1 = '01HXFIX0000000000000CRIT1';
const MAX_DIFF_BYTES = 2_000_000;

const APP_BASE = [
  'export function app(): string {',
  "  const alpha = 'alpha';",
  "  const beta = 'beta';",
  "  const gamma = 'gamma';",
  "  return 'joined';",
  '}',
  '',
].join('\n');
const APP_AFTER_CP1 = APP_BASE.replace(
  "  const alpha = 'alpha';",
  "  const alpha = 'alpha';\n  const delta = 'delta';"
);
const APP_AFTER_CP2 = APP_AFTER_CP1.replace("  const beta = 'beta';\n", '').replace(
  "  const gamma = 'gamma';\n",
  ''
);
const KEEP_BASE = 'export const keep1 = 1;\nexport const keep2 = 2;\nexport const keep3 = 3;\n';
const FEATURE_TS = 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n';
const GAP_TS = "export const gap1 = 'uncaptured-1';\nexport const gap2 = 'uncaptured-2';\n";
const FIRST_BASE =
  "export const first1 = 'one';\nexport const first2 = 'two';\nexport const first3 = 'three';\n";
const FIRST_AFTER_CP1 = FIRST_BASE.replace("export const first2 = 'two';\n", '');
const LEGACY_BASE =
  "export const legacyA = 'a';\nexport const legacyB = 'b';\nexport const legacyC = 'c';\nexport const legacyD = 'd';\n";
const LEGACY2_AFTER_CP2 = LEGACY_BASE.replace("export const legacyB = 'b';\n", '');
const MIX_BASE =
  'export const m1 = 1;\nexport const m2 = 2;\nexport const m3 = 3;\nexport const m4 = 4;\nexport const m5 = 5;\n';
const MIX_AFTER_CP1 = MIX_BASE.replace('export const m2 = 2;\n', '');
const MIX_AFTER_CP2 = MIX_AFTER_CP1.replace('export const m3 = 3;\n', '').replace(
  'export const m4 = 4;\n',
  ''
);

interface Fixture {
  repo: TempRepo;
  baseSha: string;
  cp1Sha: string;
  cp2Sha: string;
  scopeInputs: ScopeInputs;
}

interface CheckpointSpec {
  n: number;
  declaredStepIds: string[];
  completedStepIds: string[];
  summary: string;
  filesChanged: string[];
  mutate: () => Promise<void>;
  decisions?: ReviewCheckpoint['decisions'];
  uncertainty?: string[];
  doneCriteria?: ReviewCheckpoint['doneCriteria'];
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runGit(root, args, {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: PINNED_DATE,
      GIT_COMMITTER_DATE: PINNED_DATE,
    },
  });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.toString('utf8').trim();
}

async function captureTree(
  repo: Repo,
  artifactId: string,
  n: number,
  phase: 'open' | 'close'
): Promise<string> {
  const snapshot = await captureCheckpointSnapshot({
    repo,
    artifactId,
    checkpointN: n,
    phase,
  });
  if (!snapshot.ok) throw new Error(`${phase} snapshot failed: ${snapshot.error_reason}`);
  return snapshot.tree_sha;
}

async function capturedCheckpoint(
  repo: Repo,
  artifactId: string,
  spec: CheckpointSpec,
  closedAt: string,
  maxDiffBytes = MAX_DIFF_BYTES
): Promise<ReviewCheckpoint> {
  const openTreeSha = await captureTree(repo, artifactId, spec.n, 'open');
  await spec.mutate();
  const headSha = await repo.getHeadSha();
  const closeTreeSha = await captureTree(repo, artifactId, spec.n, 'close');
  const diff = await diffSnapshotTrees({
    repo,
    openTreeSha,
    closeTreeSha,
    maxDiffBytes,
  });
  if (!diff.ok) throw new Error('checkpoint boundary diff failed');
  const captured = await buildDiffFingerprintManifest({
    artifactId,
    checkpointN: spec.n,
    openTreeSha,
    closeTreeSha,
    diffBytes: diff.diff,
    truncated: diff.truncated,
    maxDiffBytes,
  });
  if (captured.manifest === null) throw new Error('checkpoint manifest was not captured');
  return {
    artifact: artifactId,
    n: spec.n,
    closedAt,
    status: 'closed',
    openTreeSha,
    closeTreeSha,
    headSha,
    summary: spec.summary,
    filesChanged: spec.filesChanged,
    completedStepIds: spec.completedStepIds,
    declaredStepIds: spec.declaredStepIds,
    decisions: spec.decisions ?? [],
    uncertainty: spec.uncertainty ?? [],
    doneCriteria: spec.doneCriteria ?? [],
    verification: [
      { command: 'fixture verification', exitCode: 0, outputDigest: null, note: null },
    ],
    manifestHash: captured.summary.manifest_hash,
    manifestTruncated: captured.summary.truncated,
    capturedFingerprint: {
      loadState: 'loaded',
      openTreeSha: captured.manifest.open_tree_sha,
      closeTreeSha: captured.manifest.close_tree_sha,
      maxDiffBytes: captured.manifest.limits.max_diff_bytes,
      diffOptions: captured.manifest.diff_options,
    },
    derivedManifestHash: null,
    overlapAmbiguousFiles: [],
    windowOverlap: undefined,
    attributionDegraded: undefined,
  };
}

async function buildFixture(): Promise<Fixture> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  const root = repo.path;
  const write = async (relative: string, content: string): Promise<void> => {
    await writeFile(path.join(root, relative), content, 'utf8');
  };
  await mkdir(path.join(root, 'src'), { recursive: true });
  await write(
    '.gitignore',
    '.orcaops/artifacts/\n.orcaops/cache/\n.orcaops/reviews/\n.orcaops/usage/\n'
  );
  await write('src/app.ts', APP_BASE);
  await write('src/keep.ts', KEEP_BASE);
  await write('src/first.ts', FIRST_BASE);
  await write('src/legacy.ts', LEGACY_BASE);
  await write('src/mix.ts', MIX_BASE);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base content']);
  const baseSha = await git(root, ['rev-parse', 'HEAD']);
  const baseTreeSha = await git(root, ['rev-parse', 'HEAD^{tree}']);
  await git(root, ['checkout', '-b', BRANCH]);
  const gitRepo = new Repo(root);

  const cp1 = await capturedCheckpoint(
    gitRepo,
    ARTIFACT,
    {
      n: 1,
      declaredStepIds: [STEP_1],
      completedStepIds: [STEP_1],
      summary: 'added feature module and the delta constant; dropped first2 and m2',
      filesChanged: ['src/feature.ts', 'src/app.ts', 'src/first.ts', 'src/mix.ts'],
      mutate: async () => {
        await write('src/feature.ts', FEATURE_TS);
        await write('src/app.ts', APP_AFTER_CP1);
        await write('src/first.ts', FIRST_AFTER_CP1);
        await write('src/mix.ts', MIX_AFTER_CP1);
      },
      decisions: [
        {
          decision: 'greet() returns a template literal',
          reason: 'simplest formatting that reads well',
          alternativesConsidered: [
            { option: 'string concatenation', rejectedBecause: 'less readable for no gain' },
          ],
        },
      ],
      uncertainty: ['greeting format may need i18n later'],
      doneCriteria: [{ criterionId: CRIT_1, evidence: 'src/feature.ts added with greet()' }],
    },
    '2026-01-02T03:10:00.000Z'
  );
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'feature module']);
  const cp1Sha = await git(root, ['rev-parse', 'HEAD']);

  await write('src/gap.ts', GAP_TS);
  const cp2 = await capturedCheckpoint(
    gitRepo,
    ARTIFACT,
    {
      n: 2,
      declaredStepIds: [STEP_2],
      completedStepIds: [STEP_2],
      summary: 'trimmed constants, deleted keep.ts, renamed legacy.ts, and removed mix rows',
      filesChanged: ['src/app.ts', 'src/keep.ts', 'src/legacy.ts', 'src/legacy2.ts', 'src/mix.ts'],
      mutate: async () => {
        await write('src/app.ts', APP_AFTER_CP2);
        await unlink(path.join(root, 'src/keep.ts'));
        await unlink(path.join(root, 'src/legacy.ts'));
        await write('src/legacy2.ts', LEGACY2_AFTER_CP2);
        await write('src/mix.ts', MIX_AFTER_CP2);
      },
      decisions: [
        {
          decision: 'delete keep.ts outright',
          reason: 'dead module with no consumers',
          alternativesConsidered: [
            { option: 'deprecate first', rejectedBecause: 'nothing imports it' },
          ],
        },
      ],
      uncertainty: ['keep.ts removal assumes no out-of-repo consumers'],
    },
    '2026-01-02T03:20:00.000Z'
  );
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'trim dead code']);
  const cp2Sha = await git(root, ['rev-parse', 'HEAD']);

  const artifact: ReviewArtifact = {
    id: ARTIFACT,
    branch: BRANCH,
    label: 'fixture capture',
    task: 'feature module, then trim dead code',
    baseSha,
    startedAt: '2026-01-02T03:00:00.000Z',
    firstActivityAt: cp1.closedAt,
    planSteps: [
      {
        stepId: STEP_1,
        text: 'add the feature module',
        label: 'feature module',
        acceptanceCriteria: [{ criterionId: CRIT_1, text: 'feature.ts exists with greet()' }],
      },
      {
        stepId: STEP_2,
        text: 'trim app.ts and remove keep.ts',
        label: 'trim dead code',
        acceptanceCriteria: [],
      },
      {
        stepId: STEP_3,
        text: 'wire the feature into the CLI',
        label: 'CLI wiring',
        acceptanceCriteria: [],
      },
    ],
    nonGoals: [],
    planDecisions: [],
    summaryText: null,
    evaluatorRuns: [],
    planRevisions: 0,
    checkpoints: [cp1, cp2],
  };
  return {
    repo,
    baseSha,
    cp1Sha,
    cp2Sha,
    scopeInputs: {
      input: {
        branch: BRANCH,
        branchSlug: slugifyBranch(BRANCH),
        baseSha,
        baseTreeSha,
        pinnedTreeSha: cp2.closeTreeSha!,
        defaultBranch: 'main',
        worktreeHead: cp2Sha,
        artifacts: [artifact],
      },
      fingerprintMaxDiffBytes: MAX_DIFF_BYTES,
      reviewMaxDiffBytes: MAX_DIFF_BYTES,
      reviewIncludedUntracked: [],
      disclosures: [],
    },
  };
}

function freshScopeInputs(scopeInputs: ScopeInputs): ScopeInputs {
  return structuredClone(scopeInputs);
}

function scopeFor(options: {
  branch: string;
  artifact: ReviewArtifact;
  baseSha: string;
  baseTreeSha: string;
  pinnedTreeSha: string;
  worktreeHead: string;
}): ScopeInputs {
  return {
    input: {
      branch: options.branch,
      branchSlug: slugifyBranch(options.branch),
      baseSha: options.baseSha,
      baseTreeSha: options.baseTreeSha,
      pinnedTreeSha: options.pinnedTreeSha,
      defaultBranch: 'main',
      worktreeHead: options.worktreeHead,
      artifacts: [options.artifact],
    },
    fingerprintMaxDiffBytes: MAX_DIFF_BYTES,
    reviewMaxDiffBytes: MAX_DIFF_BYTES,
    reviewIncludedUntracked: [],
    disclosures: [],
  };
}

async function buildFixtureFloor(fixture: Fixture, options: { scopeInputs?: ScopeInputs } = {}) {
  return buildFloor({
    root: fixture.repo.path,
    branch: BRANCH,
    now: NOW,
    scopeInputs: freshScopeInputs(options.scopeInputs ?? fixture.scopeInputs),
  });
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = await buildFixture();
}, 60_000);

afterAll(async () => {
  await fixture.repo.cleanup();
});

describe('buildFloor over canonical scope inputs', () => {
  it('assembles byte-stable attribution, integrity, citations, and plan coverage', async () => {
    const first = await buildFixtureFloor(fixture);
    const second = await buildFixtureFloor(fixture);
    expect(JSON.stringify(second.floor)).toBe(JSON.stringify(first.floor));
    expect(second.reviewDiff).toEqual(first.reviewDiff);
    expect(second.attributionLines).toEqual(first.attributionLines);
    expect(second.fingerprint).toBe(first.fingerprint);

    const floor = first.floor;
    expect(floor.scope).toMatchObject({
      branch: BRANCH,
      branch_slug: slugifyBranch(BRANCH),
      base_sha: fixture.baseSha,
      pinned_tree_sha: fixture.scopeInputs.input.pinnedTreeSha,
      default_branch: 'main',
      artifact_ids: [ARTIFACT],
    });
    expect(floor.attribution.active_rung).toBe('snapshot_chain');
    expect(floor.integrity).toEqual([
      { artifact: ARTIFACT, cp: 1, verified: true },
      { artifact: ARTIFACT, cp: 2, verified: true },
    ]);

    const byFile = new Map<string, (typeof floor.coverage.items)[number][]>();
    for (const item of floor.coverage.items) {
      const values = byFile.get(item.file) ?? [];
      values.push(item);
      byFile.set(item.file, values);
    }
    const owners = (file: string): number[] =>
      (byFile.get(file) ?? []).flatMap((item) =>
        item.units.flatMap((unit) => (unit.kind === 'owned_slice' ? [unit.owner.cp] : []))
      );
    expect(byFile.get('src/feature.ts')?.[0]?.verdict).toBe(COVERAGE_VERDICT.MATCHED);
    expect(new Set(owners('src/app.ts'))).toEqual(new Set([1, 2]));
    expect(owners('src/keep.ts')).toEqual([2]);
    expect(owners('src/first.ts')).toEqual([1]);
    expect(byFile.has('src/legacy.ts')).toBe(false);
    expect(owners('src/legacy2.ts')).toEqual([2]);
    expect(new Set(owners('src/mix.ts'))).toEqual(new Set([1, 2]));
    expect(byFile.get('src/gap.ts')?.[0]?.verdict).toBe(COVERAGE_VERDICT.UNEXPLAINED);
    expect(floor.outline.unassigned.gap.files.map((entry) => entry.file)).toEqual(['src/gap.ts']);

    expect(first.attributionLines.some((line) => line.side === 'add')).toBe(true);
    expect(first.attributionLines.some((line) => line.side === 'delete')).toBe(true);
    expect(
      first.attributionLines.find(
        (line) => line.side === 'delete' && line.file === 'src/legacy2.ts'
      )?.owner
    ).toEqual({ kind: 'checkpoint', artifact: ARTIFACT, cp: 2 });
    expect(new Set(floor.citations.map((citation) => citation.kind))).toEqual(
      expect.objectContaining(new Set(['CHECKPOINT_DECISION', 'CHECKPOINT_UNCERTAINTY']))
    );
    expect(floor.plan_coverage.find((step) => step.step_id === STEP_1)?.claimed_by).toEqual([
      { artifact: ARTIFACT, cp: 1 },
    ]);
    expect(floor.plan_coverage.find((step) => step.step_id === STEP_3)?.unclaimed).toBe(true);
  });

  it('uses retained manifest inputs when the live fingerprint cap changes', async () => {
    const changed = freshScopeInputs(fixture.scopeInputs);
    changed.fingerprintMaxDiffBytes = MAX_DIFF_BYTES * 2;
    const result = await buildFixtureFloor(fixture, { scopeInputs: changed });
    expect(result.floor.integrity).toEqual([
      { artifact: ARTIFACT, cp: 1, verified: true },
      { artifact: ARTIFACT, cp: 2, verified: true },
    ]);
  });

  it('verifies a truncated retained manifest after the live fingerprint cap changes', async () => {
    const changed = freshScopeInputs(fixture.scopeInputs);
    const checkpoint = changed.input.artifacts[0]!.checkpoints[0]!;
    const retainedCap = 128;
    const diff = await diffSnapshotTrees({
      repo: new Repo(fixture.repo.path),
      openTreeSha: checkpoint.openTreeSha!,
      closeTreeSha: checkpoint.closeTreeSha!,
      maxDiffBytes: retainedCap,
    });
    if (!diff.ok) throw new Error('checkpoint boundary diff failed');
    const captured = await buildDiffFingerprintManifest({
      artifactId: ARTIFACT,
      checkpointN: checkpoint.n,
      openTreeSha: checkpoint.openTreeSha!,
      closeTreeSha: checkpoint.closeTreeSha!,
      diffBytes: diff.diff,
      truncated: diff.truncated,
      maxDiffBytes: retainedCap,
    });
    if (captured.manifest === null) throw new Error('checkpoint manifest was not captured');
    expect(captured.summary.truncated).toBe(true);
    checkpoint.manifestHash = captured.summary.manifest_hash;
    checkpoint.manifestTruncated = captured.summary.truncated;
    checkpoint.capturedFingerprint = {
      loadState: 'loaded',
      openTreeSha: captured.manifest.open_tree_sha,
      closeTreeSha: captured.manifest.close_tree_sha,
      maxDiffBytes: captured.manifest.limits.max_diff_bytes,
      diffOptions: captured.manifest.diff_options,
    };
    changed.fingerprintMaxDiffBytes = MAX_DIFF_BYTES * 2;

    const result = await buildFixtureFloor(fixture, { scopeInputs: changed });
    expect(result.floor.integrity[0]).toEqual({ artifact: ARTIFACT, cp: 1, verified: true });
    expect(result.floor.disclosure.map((entry) => entry.code)).not.toContain(
      DISCLOSURE_CODE.INTEGRITY_MISMATCH
    );
  });

  it('discloses a retained manifest mismatch', async () => {
    const changed = freshScopeInputs(fixture.scopeInputs);
    const checkpoint = changed.input.artifacts[0]!.checkpoints[0]!;
    checkpoint.manifestHash = [...checkpoint.manifestHash!].reverse().join('');
    const result = await buildFixtureFloor(fixture, { scopeInputs: changed });
    expect(result.floor.integrity[0]).toEqual({ artifact: ARTIFACT, cp: 1, verified: false });
    expect(result.floor.disclosure.map((entry) => entry.code)).toContain(
      DISCLOSURE_CODE.INTEGRITY_MISMATCH
    );
  });

  it('reports failed blame as degraded attribution', async () => {
    const gitModule = await import('../../src/git.js');
    const forward = vi
      .spyOn(gitModule, 'blameFile')
      .mockResolvedValue({ ok: false, map: new Map<number, string>() });
    const reverse = vi
      .spyOn(gitModule, 'blameFileReverse')
      .mockResolvedValue({ ok: false, map: new Map<number, string>() });
    try {
      const result = await buildFixtureFloor(fixture);
      expect(result.cacheHealth.blameFailed).toBe(true);
    } finally {
      forward.mockRestore();
      reverse.mockRestore();
    }
  });

  it('keeps reverse blame honest for surviving and missing paths', async () => {
    const { blameFileReverse } = await import('../../src/git.js');
    const surviving = await blameFileReverse(
      fixture.repo.path,
      fixture.baseSha,
      fixture.cp2Sha,
      'src/app.ts'
    );
    expect(surviving.ok).toBe(true);
    expect(surviving.map.get(2)).toBe(fixture.cp2Sha);
    expect(surviving.map.get(3)).toBe(fixture.cp1Sha);
    const missing = await blameFileReverse(
      fixture.repo.path,
      fixture.baseSha,
      fixture.cp2Sha,
      'src/nope.ts'
    );
    expect(missing).toEqual({ ok: false, map: new Map() });
  });

  it('follows a two-hop rename to attribute a deleted line to the final checkpoint', async () => {
    const artifactId = 'hop-e2e-0001';
    const branch = 'feat/hop';
    const step1 = '01HXHOP0000000000000STEP1';
    const step2 = '01HXHOP0000000000000STEP2';
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const root = repo.path;
      const write = (relative: string, content: string) =>
        writeFile(path.join(root, relative), content, 'utf8');
      await mkdir(path.join(root, 'src'), { recursive: true });
      await write(
        'src/hop.ts',
        'export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n'
      );
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-m', 'base']);
      const baseSha = await git(root, ['rev-parse', 'HEAD']);
      const baseTreeSha = await git(root, ['rev-parse', 'HEAD^{tree}']);
      await git(root, ['checkout', '-b', branch]);
      const gitRepo = new Repo(root);
      const cp1 = await capturedCheckpoint(
        gitRepo,
        artifactId,
        {
          n: 1,
          declaredStepIds: [step1],
          completedStepIds: [step1],
          summary: 'renamed the source once',
          filesChanged: ['src/hop.ts', 'src/hop2.ts'],
          mutate: async () => {
            await git(root, ['mv', 'src/hop.ts', 'src/hop2.ts']);
          },
        },
        '2026-01-02T06:10:00.000Z'
      );
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-m', 'first rename']);
      const cp2 = await capturedCheckpoint(
        gitRepo,
        artifactId,
        {
          n: 2,
          declaredStepIds: [step2],
          completedStepIds: [step2],
          summary: 'renamed the source again and removed beta',
          filesChanged: ['src/hop2.ts', 'src/hop3.ts'],
          mutate: async () => {
            await git(root, ['mv', 'src/hop2.ts', 'src/hop3.ts']);
            await write('src/hop3.ts', 'export const alpha = 1;\nexport const gamma = 3;\n');
          },
        },
        '2026-01-02T06:20:00.000Z'
      );
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-m', 'second rename']);
      const worktreeHead = await git(root, ['rev-parse', 'HEAD']);
      const artifact: ReviewArtifact = {
        id: artifactId,
        branch,
        label: 'rename fixture',
        task: 'rename a source twice and remove one line',
        baseSha,
        startedAt: '2026-01-02T06:00:00.000Z',
        firstActivityAt: cp1.closedAt,
        planSteps: [
          { stepId: step1, text: 'rename once', label: 'first rename', acceptanceCriteria: [] },
          {
            stepId: step2,
            text: 'rename and trim',
            label: 'second rename',
            acceptanceCriteria: [],
          },
        ],
        nonGoals: [],
        planDecisions: [],
        summaryText: null,
        evaluatorRuns: [],
        planRevisions: 0,
        checkpoints: [cp1, cp2],
      };
      const result = await buildFloor({
        root,
        branch,
        now: NOW,
        scopeInputs: scopeFor({
          branch,
          artifact,
          baseSha,
          baseTreeSha,
          pinnedTreeSha: cp2.closeTreeSha!,
          worktreeHead,
        }),
      });
      expect(result.floor.coverage.items.some((item) => item.file === 'src/hop.ts')).toBe(false);
      expect(result.floor.coverage.items.some((item) => item.file === 'src/hop2.ts')).toBe(false);
      expect(
        result.attributionLines.filter(
          (line) => line.side === 'delete' && line.file === 'src/hop3.ts'
        )
      ).toEqual([
        expect.objectContaining({
          owner: { kind: 'checkpoint', artifact: artifactId, cp: 2 },
        }),
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps layered line attribution and outline chapters aligned', async () => {
    const artifactId = 'layer-e2e-0001';
    const branch = 'feat/layered';
    const steps = [
      '01HXLAY0000000000000STEP1',
      '01HXLAY0000000000000STEP2',
      '01HXLAY0000000000000STEP3',
    ];
    const sequence = (prefix: string, from: number, to: number): string[] =>
      Array.from(
        { length: to - from + 1 },
        (_, index) =>
          `export const ${prefix}${String(from + index).padStart(2, '0')} = ${from + index};`
      );
    const body = (lines: string[]): string => `${lines.join('\n')}\n`;
    const a1 = body(sequence('a', 1, 20));
    const a2 = body([...sequence('a', 1, 10), ...sequence('x', 1, 25), ...sequence('a', 11, 20)]);
    const aGap = a2.replace('export const a05 = 5;', 'export const a05 = 505;');
    const a3 = aGap.replace(
      'export const x10 = 10;',
      'export const x10 = 1010;\nexport const x10b = 1011;'
    );
    const b1 = body(sequence('b', 1, 10));
    const b2 = body([...sequence('b', 1, 5), ...sequence('y', 1, 15), ...sequence('b', 6, 10)]);
    const c1 = body(sequence('c', 1, 10));
    const c2 = body([...sequence('c', 1, 5), ...sequence('z', 1, 3), ...sequence('c', 6, 10)]);
    const d2 = body(sequence('d', 1, 15));
    const d3 = d2.replace(
      'export const d10 = 10;',
      'export const d10 = 1010;\nexport const d10b = 1011;'
    );
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const root = repo.path;
      const write = (relative: string, content: string) =>
        writeFile(path.join(root, relative), content, 'utf8');
      await mkdir(path.join(root, 'src'), { recursive: true });
      await write('src/readme.md', 'layered fixture base\n');
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-m', 'base']);
      const baseSha = await git(root, ['rev-parse', 'HEAD']);
      const baseTreeSha = await git(root, ['rev-parse', 'HEAD^{tree}']);
      await git(root, ['checkout', '-b', branch]);
      const gitRepo = new Repo(root);
      const checkpoints: ReviewCheckpoint[] = [];
      const capture = async (
        n: number,
        filesChanged: string[],
        mutate: () => Promise<void>
      ): Promise<void> => {
        const checkpoint = await capturedCheckpoint(
          gitRepo,
          artifactId,
          {
            n,
            declaredStepIds: [steps[n - 1]!],
            completedStepIds: [steps[n - 1]!],
            summary: `captured layered changes ${n}`,
            filesChanged,
            mutate,
          },
          `2026-01-02T07:${String(n * 10).padStart(2, '0')}:00.000Z`
        );
        checkpoints.push(checkpoint);
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-m', `layer ${n}`]);
      };
      await capture(1, ['src/a.ts', 'src/b.ts', 'src/c.ts'], async () => {
        await write('src/a.ts', a1);
        await write('src/b.ts', b1);
        await write('src/c.ts', c1);
      });
      await capture(2, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], async () => {
        await write('src/a.ts', a2);
        await write('src/b.ts', b2);
        await write('src/c.ts', c2);
        await write('src/d.ts', d2);
      });
      await write('src/a.ts', aGap);
      await capture(3, ['src/a.ts', 'src/d.ts'], async () => {
        await write('src/a.ts', a3);
        await write('src/d.ts', d3);
      });
      const worktreeHead = await git(root, ['rev-parse', 'HEAD']);
      const artifact: ReviewArtifact = {
        id: artifactId,
        branch,
        label: 'layered fixture',
        task: 'layer changes across shared files',
        baseSha,
        startedAt: '2026-01-02T07:00:00.000Z',
        firstActivityAt: checkpoints[0]!.closedAt,
        planSteps: steps.map((stepId, index) => ({
          stepId,
          text: `capture layer ${index + 1}`,
          label: `layer ${index + 1}`,
          acceptanceCriteria: [],
        })),
        nonGoals: [],
        planDecisions: [],
        summaryText: null,
        evaluatorRuns: [],
        planRevisions: 0,
        checkpoints,
      };
      const result = await buildFloor({
        root,
        branch,
        now: NOW,
        scopeInputs: scopeFor({
          branch,
          artifact,
          baseSha,
          baseTreeSha,
          pinnedTreeSha: checkpoints[2]!.closeTreeSha!,
          worktreeHead,
        }),
      });
      const filesOwnedBy = (checkpoint: number): string[] =>
        [
          ...new Set(
            result.attributionLines.flatMap((line) =>
              line.owner.kind === 'checkpoint' && line.owner.cp === checkpoint ? [line.file] : []
            )
          ),
        ].sort();
      expect(filesOwnedBy(1)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
      expect(filesOwnedBy(2)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
      expect(filesOwnedBy(3)).toEqual(['src/a.ts', 'src/d.ts']);
      expect(
        result.attributionLines.filter(
          (line) => line.owner.kind === 'gap' && line.file === 'src/a.ts'
        )
      ).toEqual([expect.objectContaining({ side: 'add', line: 5 })]);
      const fileByHunk = new Map(
        result.floor.coverage.items.map((item) => [item.hunkKey, item.file])
      );
      const chapterFiles = (checkpoint: number): string[] =>
        [
          ...new Set(
            (
              result.floor.outline.threads
                .flatMap((thread) => thread.checkpoints)
                .find((chapter) => chapter.checkpoint.cp === checkpoint)?.sliceRefs ?? []
            ).flatMap((ref) => {
              const file = fileByHunk.get(ref.hunkKey);
              return file === undefined ? [] : [file];
            })
          ),
        ].sort();
      expect(chapterFiles(1)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
      expect(chapterFiles(2)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
      expect(chapterFiles(3)).toEqual(['src/a.ts', 'src/d.ts']);
      expect(result.floor.outline.unassigned.gap.files).toEqual([
        { file: 'src/a.ts', slice_count: 1, added_rows: 1, removed_rows: 0 },
      ]);
      expect(result.floor.outline.unassigned.ambiguous.hunkKeys).toEqual([]);
      for (const item of result.floor.coverage.items) {
        expect(item.units.reduce((total, unit) => total + unit.lines, 0)).toBe(
          item.added_lines + item.removed_lines
        );
      }
    } finally {
      await repo.cleanup();
    }
  });
});
