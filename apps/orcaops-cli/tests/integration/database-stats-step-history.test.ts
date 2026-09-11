import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig, uuidv7 } from '@orcaops/storage';

import {
  DIFF_ATTRIBUTION_NOT_MEASURED,
  measureDiffAttribution,
} from '../../src/lib/database-diff.js';
import { readDatabaseStats } from '../../src/lib/database-stats.js';
import { readDatabaseStepBrief, validateDatabaseStepBrief } from '../../src/lib/database-step.js';
import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, inventory } from '../helpers/database-history.js';

const readers = new Set<{ close(): void }>();
afterEach(() => {
  for (const reader of readers) reader.close();
  readers.clear();
});

async function scopeFor(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { profile: 'collection' | 'exact'; selector: { projectId?: string } }
) {
  const scope = await resolveDatabaseHistoryScope({
    root: f.root,
    cwd: f.main,
    profile: options.profile,
    selector: options.selector,
  });
  readers.add(scope);
  return { scope, config: getDefaultConfig() };
}

const legacyStepId = 'plan-step/legacy identifier 3';
function steps(ids: string[]) {
  return ids.map((step_id, index) => ({
    step_id,
    text: `Step ${index + 1}`,
    label: `Step ${index + 1}`,
    acceptance_criteria: [],
  }));
}

describe('stats and step brief on canonical history', () => {
  it('keeps the ambiguity error shape when a step id recurs across artifacts', async () => {
    const f = await fixture();
    const first = await f.capture(undefined, { steps: steps([legacyStepId]) });
    const second = await f.capture(undefined, { steps: steps([legacyStepId]) });
    const context = await scopeFor(f, validateDatabaseStepBrief(legacyStepId, {}));
    let thrown: unknown;
    try {
      readDatabaseStepBrief(context, legacyStepId, {});
    } catch (error) {
      thrown = error;
    }
    const shape = thrown as { code?: string; message?: string };
    expect(shape.code).toBe('AMBIGUOUS_ARTIFACT');
    expect(shape.message).toContain(`step_id "${legacyStepId}" appears in 2 artifacts`);
    expect(shape.message).toContain('Pass --artifact <id> to disambiguate.');
    for (const id of [first, second]) expect(shape.message).toContain(id);
  });

  it('resolves a non-UUID historical step id through the membership index', async () => {
    const f = await fixture();
    const artifactId = await f.capture(undefined, { steps: steps([legacyStepId, uuidv7()]) });
    const context = await scopeFor(f, validateDatabaseStepBrief(legacyStepId, {}));
    const brief = readDatabaseStepBrief(context, legacyStepId, {}) as {
      artifact_id: string;
      step: { step_id: string; dropped_in_latest_revision: boolean };
      siblings: unknown[];
    };
    expect(brief.artifact_id).toBe(artifactId);
    expect(brief.step.step_id).toBe(legacyStepId);
    expect(brief.step.dropped_in_latest_revision).toBe(false);
    expect(brief.siblings).toHaveLength(1);
  });

  it('counts imported artifacts in base sections but never in churn, durations or hygiene', async () => {
    const f = await fixture();
    const captured = await f.capture(undefined, { reason: 'completed' });
    await f.recordFiles(captured, ['src/captured.ts']);
    const imported = await f.capture(undefined, { reason: 'imported' });
    await f.recordFiles(imported, ['src/imported.ts']);
    const context = await scopeFor(f, { profile: 'collection', selector: {} });
    const result = readDatabaseStats(context, {}, DIFF_ATTRIBUTION_NOT_MEASURED);
    expect(result.artifacts.total).toBe(2);
    expect(result.checkpoints.total).toBe(2);
    expect(result.imported_artifacts).toBe(1);
    expect(result.plan_revisions.artifacts_with_plan).toBe(1);
    expect(result.checkpoint_durations.closed_total).toBe(1);
    expect(result.hygiene.closed_cp_without_completed_steps).toBe(1);
    expect(result.hygiene.diff_attributed_pct).toBeNull();
  });

  it('leaves every byte and the write sequence untouched across stats reads', async () => {
    const f = await fixture();
    await f.capture(undefined, { reason: 'completed' });
    await f.capture(undefined, { reason: 'imported' });
    const before = await inventory(f.temporary);
    const context = await scopeFor(f, { profile: 'collection', selector: {} });
    const sequenceOf = () =>
      readDatabaseStats(context, {}, DIFF_ATTRIBUTION_NOT_MEASURED).sources[0].counters
        .writeSequence;
    const first = sequenceOf();
    expect(sequenceOf()).toBe(first);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('serves a project whose expected history is gone as unknown and writes nothing', async () => {
    const f = await fixture();
    await f.capture();
    f.writer.close();
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${f.writer.databasePath}${suffix}`, { force: true });
    }
    const before = await inventory(f.temporary);
    const context = await scopeFor(f, { profile: 'collection', selector: {} });
    const served = readDatabaseStats(context, {}, DIFF_ATTRIBUTION_NOT_MEASURED);
    expect(await inventory(f.temporary)).toEqual(before);
    expect(served.completeness.complete).toBe(false);
    expect(served.completeness.issues.map((issue) => issue.code)).toEqual(['HISTORY_MISSING']);
    expect(served.coverage.counted_projects).toEqual([]);
    expect(served.coverage.unknown_projects).toEqual([served.completeness.issues[0].project_id]);
  });
});

/** Stages the three conflict entries a merge would leave, without running a merge. */
function forgeConflict(repoPath: string, file: string): void {
  const stage = (content: string, slot: number): string => {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repoPath,
      input: content,
      encoding: 'utf8',
    }).trim();
    return `100644 ${sha} ${slot}\t${file}`;
  };
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: repoPath,
    input: `${[stage('base\n', 1), stage('ours\n', 2), stage('theirs\n', 3)].join('\n')}\n`,
  });
}

describe('stats attributed change', { timeout: 60_000 }, () => {
  it('attributes the latest artifact window against the live worktree', async () => {
    const f = await fixture();
    const base = await commitFile(f, 'src/base.ts', 'export const base = 1;\n');
    const id = await f.capture();
    const head = await commitFile(f, 'src/work.ts', 'export const work = 1;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/work.ts'],
      openRef: base,
      closeRef: head,
    });
    const context = await scopeFor(f, { profile: 'collection', selector: {} });

    const measured = await measureDiffAttribution(context);
    expect(measured).toMatchObject({ state: 'measured' });
    expect(measured.state === 'measured' ? measured.attributed_pct : null).toBeGreaterThan(0);
    expect(readDatabaseStats(context, {}, measured).hygiene.diff_attributed_pct).toBe(
      measured.state === 'measured' ? measured.attributed_pct : null
    );

    // A conflicted index keeps the hint null: marker hunks would silently dip a
    // scalar the output has nowhere to qualify.
    forgeConflict(f.main, 'conflict.txt');
    const conflicted = await measureDiffAttribution(context);
    expect(conflicted).toMatchObject({ state: 'unavailable', reason: 'UNMERGED_INDEX' });
    expect(readDatabaseStats(context, {}, conflicted).hygiene.diff_attributed_pct).toBeNull();
  });

  it('names the missing precondition instead of answering a bare number', async () => {
    const f = await fixture();
    const context = await scopeFor(f, { profile: 'collection', selector: {} });
    expect(await measureDiffAttribution(context)).toMatchObject({
      state: 'unavailable',
      reason: 'ARTIFACT_BASE_UNAVAILABLE',
    });
    const id = await f.capture();
    await f.recordFiles(id, ['src/recorded.ts']);
    expect(await measureDiffAttribution(context)).toMatchObject({
      state: 'unavailable',
      reason: 'NO_MANIFEST_SOURCES',
    });
    // The statistics read performs no Git work of its own: it reports what it was given.
    expect(
      readDatabaseStats(context, {}, DIFF_ATTRIBUTION_NOT_MEASURED).hygiene.diff_attribution
    ).toEqual(DIFF_ATTRIBUTION_NOT_MEASURED);
  });
});
