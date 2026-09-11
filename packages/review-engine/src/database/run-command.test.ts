import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import { capturedReviewFixture } from '../../tests/capturedReviewFixture.js';
import { STORY_REVIEW_MODEL_FILE } from '../storyReviewModel.js';
import { renderAccountRoutineMd, renderForensicRoutineMd } from '../twolaneRunCli.js';
import {
  finalizeCanonicalRun,
  readCanonicalRun,
  readCanonicalRunFinalization,
  recordCanonicalLaneServed,
  startCanonicalRun,
  submitCanonicalLane,
} from './run-command.js';
import { recordDatabaseReviewInputsServed } from './run-progress.js';

const FORENSIC = JSON.stringify({
  findings: [
    {
      claim: 'The limiter has no shared clock across processes.',
      file: 'src/limiter.ts',
      related_files: [],
      severity: 'CAUTION',
      confidence: 'HIGH',
    },
  ],
  questions: [],
});

async function fixtureWithRun(overrides: Partial<Parameters<typeof startCanonicalRun>[0]> = {}) {
  const f = await capturedReviewFixture();
  await f.publishFloor();
  const started = await startCanonicalRun({
    branch: f.branch,
    root: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.projectId,
    profile: 'routine',
    createdAt: '2026-06-10T00:00:00.000Z',
    runtimeIdentity: null,
    executionProfile: {
      host: null,
      host_version: null,
      model: null,
      effort: null,
      launcher_mode: null,
      instruction_hash: null,
    },
    operationId: uuidv7(),
    secretAllow: [],
    ...overrides,
  });
  const locator = {
    branch: f.branch,
    root: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.projectId,
  };
  return { f, started, locator };
}

function accountPayload(markdown: string) {
  const checkpoints = [...markdown.matchAll(/^#### (k\d+) ·/gm)].map((match) => match[1]!);
  const citation = /\[(c\d+)\]/.exec(markdown)?.[1];
  expect(checkpoints.length).toBeGreaterThan(0);
  expect(citation).toBeDefined();
  return JSON.stringify({
    schema_version: 1,
    overview: {
      text: 'The captured checkpoints carry one bounded feature from intent to code.',
      citations: [citation],
    },
    acts: [
      {
        title: 'Carry the feature',
        interpretation: 'Every captured checkpoint lands in one act.',
        parts: [
          {
            title: 'Captured work',
            checkpoints,
            interpretation: 'The changed files implement the captured checkpoints.',
            citations: [citation],
          },
        ],
      },
    ],
    questions: [],
  });
}

it('mints a run whose pinned inputs and selection are retained rows', async () => {
  const { f, started } = await fixtureWithRun();
  expect(started.runId).toMatch(/^[0-9a-f-]{36}$/);
  const rows = await f.read(
    (database) =>
      database.read((view) => ({
        runs: view.all<{ run_id: string; version: number }>(
          'SELECT run_id, version FROM review_runs'
        ),
        selection: view.get<{ current_run_id: string | null; run_selection_version: number }>(
          'SELECT current_run_id, run_selection_version FROM review_selections'
        ),
        inputs: view.all<{ name: string }>(
          "SELECT name FROM review_evidence_members WHERE kind = 'run-input' ORDER BY name"
        ),
      })).value
  );
  expect(rows.runs).toEqual([{ run_id: started.runId, version: 1 }]);
  expect(rows.selection).toEqual({
    current_run_id: started.runId,
    run_selection_version: 1,
  });
  expect(rows.inputs.map((row) => row.name)).toEqual([
    'account-projection-v1.json',
    'coverage-v1.json',
    'diff.patch',
    'dossier-v1.json',
    'forensic-input-v1.json',
  ]);
}, 180_000);

it('records a lane input as served exactly once', async () => {
  const { started, locator } = await fixtureWithRun();
  const first = await recordCanonicalLaneServed({
    ...locator,
    runId: started.runId,
    lane: 'forensic',
    servedAt: '2026-06-10T00:01:00.000Z',
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(first).toMatchObject({ recorded: true, servedAt: '2026-06-10T00:01:00.000Z' });
  const second = await recordCanonicalLaneServed({
    ...locator,
    runId: started.runId,
    lane: 'forensic',
    servedAt: '2026-06-10T00:02:00.000Z',
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(second).toMatchObject({ recorded: false, servedAt: '2026-06-10T00:01:00.000Z' });
  const read = await readCanonicalRun({ ...locator, runId: started.runId });
  expect(read!.run.lane_inputs_served).toEqual({ forensic: '2026-06-10T00:01:00.000Z' });
  expect(read!.version).toBe(2);
}, 180_000);

it('refuses an account input before the forensic lane is terminal', async () => {
  const { started, locator } = await fixtureWithRun();
  await expect(
    recordCanonicalLaneServed({
      ...locator,
      runId: started.runId,
      lane: 'account',
      servedAt: '2026-06-10T00:01:00.000Z',
      operationId: uuidv7(),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
}, 180_000);

it('refuses an old progress snapshot over newer progress', async () => {
  const { f, started, locator } = await fixtureWithRun();
  const before = (await readCanonicalRun({ ...locator, runId: started.runId }))!;
  await recordCanonicalLaneServed({
    ...locator,
    runId: started.runId,
    lane: 'forensic',
    servedAt: '2026-06-10T00:01:00.000Z',
    operationId: uuidv7(),
    secretAllow: [],
  });
  const superseded = {
    ...before.run,
    lane_inputs_served: { forensic: '2026-06-10T00:09:00.000Z' },
  };
  await expect(
    recordDatabaseReviewInputsServed({
      authority: f.authority,
      reviewId: before.reviewId,
      runId: started.runId,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      expected: {
        revisionId: before.revisionId,
        version: before.version,
        runSelectionVersion: before.runSelectionVersion,
      },
      lane: 'forensic',
      runBytes: Buffer.from(JSON.stringify(superseded, null, 2) + '\n'),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  const after = await readCanonicalRun({ ...locator, runId: started.runId });
  expect(after!.run.lane_inputs_served).toEqual({ forensic: '2026-06-10T00:01:00.000Z' });
}, 180_000);

it('refuses a submission that does not carry the run executable identity', async () => {
  const identity = {
    executablePath: '/fixture/runtime/bin/orcaops.js',
    entrypointPath: '/fixture/runtime/dist/sidecar.js',
    packageName: '@orcaops/review-engine',
    packageVersion: '0.0.0',
    packageRoot: '/fixture/runtime',
    packageLinkTarget: null,
    buildCommit: null,
    buildTimestamp: null,
    buildDirty: null,
    entrypointSha256: null,
    compiledRuntimeManifestSha256: 'c'.repeat(64),
    runtimeFingerprintSha256: 'a'.repeat(64),
  };
  const { started, locator } = await fixtureWithRun({ runtimeIdentity: identity });
  await expect(
    submitCanonicalLane({
      ...locator,
      runId: started.runId,
      lane: 'forensic',
      at: '2026-06-10T00:03:00.000Z',
      isolation: 'sequential',
      usageTokens: null,
      usageSource: null,
      runtimeIdentity: { ...identity, runtimeFingerprintSha256: 'b'.repeat(64) },
      rawSubmission: FORENSIC,
      operationId: uuidv7(),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
}, 180_000);

it('carries a run from both accepted lanes to a sealed Story', async () => {
  const { f, started, locator } = await fixtureWithRun();
  const minted = (await readCanonicalRun({ ...locator, runId: started.runId }))!;
  // The served payloads are derived from the run's own pinned inputs, so the
  // account aliases the submission cites come from the same bytes the run
  // retained rather than a second render of the worktree.
  renderForensicRoutineMd(minted.dossierInputs.forensicInput);
  const forensic = await submitCanonicalLane({
    ...locator,
    runId: started.runId,
    lane: 'forensic',
    at: '2026-06-10T00:03:00.000Z',
    isolation: 'sequential',
    usageTokens: 120,
    usageSource: 'host',
    runtimeIdentity: null,
    rawSubmission: FORENSIC,
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(forensic.accepted, JSON.stringify(forensic.diagnostics)).toBe(true);

  const served = (await readCanonicalRun({ ...locator, runId: started.runId }))!;
  const markdown = renderAccountRoutineMd(served.dossierInputs.projection, {
    runId: started.runId,
    baseSha: served.dossierInputs.forensicInput.baseSha ?? null,
    floorInputHash: served.dossierInputs.projection.floor_input_hash,
    eligibleFiles: served.dossierInputs.forensicInput.metrics.eligibleFiles,
    eligibleDiffBytes: served.dossierInputs.forensicInput.metrics.eligibleDiffBytes,
    excludedFiles: served.dossierInputs.forensicInput.metrics.excludedFiles,
    unreviewableFiles: served.dossierInputs.forensicInput.metrics.unreviewableFiles,
    policyStubFiles: 0,
    policyStubRows: 0,
    latencyTier: '<250KB → 180s',
  });
  const account = await submitCanonicalLane({
    ...locator,
    runId: started.runId,
    lane: 'account',
    at: '2026-06-10T00:04:00.000Z',
    isolation: 'sequential',
    usageTokens: null,
    usageSource: null,
    runtimeIdentity: null,
    rawSubmission: accountPayload(markdown),
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(account.accepted, JSON.stringify(account.diagnostics)).toBe(true);

  const sealed = await finalizeCanonicalRun({
    ...locator,
    runId: started.runId,
    finalizedAt: '2026-06-10T00:05:00.000Z',
    runtimeIdentity: null,
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(sealed).toMatchObject({ status: 'sealed', outcome: 'FULL' });
  expect(sealed.terminal.run_id).toBe(started.runId);
  expect(sealed.terminal.submission_count).toBe(2);
  expect(sealed.storyPublicationId).not.toBeNull();

  const finalized = (await readCanonicalRun({ ...locator, runId: started.runId }))!;
  expect(
    await readCanonicalRunFinalization({
      ...locator,
      reviewId: finalized.reviewId,
      runId: finalized.runId,
      revisionId: finalized.revisionId,
      version: finalized.version,
    })
  ).toMatchObject({
    reviewId: finalized.reviewId,
    runId: finalized.runId,
    revisionId: finalized.revisionId,
    version: finalized.version,
  });
  await expect(
    readCanonicalRunFinalization({
      ...locator,
      reviewId: minted.reviewId,
      runId: minted.runId,
      revisionId: minted.revisionId,
      version: minted.version,
    })
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });

  const rows = await f.read(
    (database) =>
      database.read((view) => ({
        story: view.all<{ name: string }>(
          "SELECT name FROM review_evidence_members WHERE kind = 'story' ORDER BY name"
        ),
        finalizations: view.all<{ run_id: string }>('SELECT run_id FROM review_run_finalizations'),
        selection: view.get<{ story_publication_id: string | null; story_version: number }>(
          'SELECT story_publication_id, story_version FROM review_selections'
        ),
      })).value
  );
  expect(rows.story.map((row) => row.name)).toEqual([
    'brief.json',
    'composed-story-v2.json',
    'review.md',
    STORY_REVIEW_MODEL_FILE,
  ]);
  expect(rows.finalizations).toEqual([{ run_id: started.runId }]);
  expect(rows.selection).toEqual({
    story_publication_id: sealed.storyPublicationId,
    story_version: 1,
  });

  // Replay: the sealed run reports its retained receipt instead of composing a
  // second Story over the same run.
  const again = await finalizeCanonicalRun({
    ...locator,
    runId: started.runId,
    finalizedAt: '2026-06-10T00:06:00.000Z',
    runtimeIdentity: null,
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(again).toMatchObject({ status: 'already-sealed', outcome: 'FULL' });
  expect(again.terminal).toEqual(sealed.terminal);
}, 300_000);

it('refuses a run start when the review has no selected floor', async () => {
  const f = await capturedReviewFixture();
  await expect(
    startCanonicalRun({
      branch: f.branch,
      root: f.gitRoot,
      dataRoot: f.dataRoot,
      projectId: f.projectId,
      profile: 'routine',
      createdAt: '2026-06-10T00:00:00.000Z',
      runtimeIdentity: null,
      executionProfile: {
        host: null,
        host_version: null,
        model: null,
        effort: null,
        launcher_mode: null,
        instruction_hash: null,
      },
      operationId: uuidv7(),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
  expect(store.projectDatabasePath(f.authority)).toContain(f.dataRoot);
}, 120_000);

it('accepts a lane submission bound to a superseded floor and refuses only the seal', async () => {
  const { f, started, locator } = await fixtureWithRun();
  const original = await readCanonicalRun({ ...locator, runId: started.runId });

  // The reviewed worktree moves and the floor is republished, so the review's
  // selected floor is no longer the one the run pinned its inputs from.
  await f.commit({ 'src/limiter.ts': 'export const allow = (): boolean => true;\n' }, 'move on');
  const republished = await f.publishFloor();
  expect(republished.floor_outcome).toBe('published');
  expect(republished.publication_id).not.toBe(original!.floorPublicationId);

  // The submission is judged against the inputs the reviewer was actually
  // served, which are the run's own pinned inputs, so it is accepted and the
  // attempt stays bound to the floor it was reviewed against.
  const submitted = await submitCanonicalLane({
    ...locator,
    runId: started.runId,
    lane: 'forensic',
    at: '2026-06-10T00:03:00.000Z',
    isolation: 'sequential',
    usageTokens: null,
    usageSource: null,
    runtimeIdentity: null,
    rawSubmission: FORENSIC,
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(submitted.accepted).toBe(true);
  const after = await readCanonicalRun({ ...locator, runId: started.runId });
  expect(after!.floorPublicationId).toBe(original!.floorPublicationId);

  // The seal is where the superseded basis matters: a Story published over a
  // floor the review no longer selects would claim to review the current tree.
  await expect(
    finalizeCanonicalRun({
      ...locator,
      runId: started.runId,
      finalizedAt: '2026-06-10T00:04:00.000Z',
      runtimeIdentity: null,
      operationId: uuidv7(),
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
}, 300_000);
