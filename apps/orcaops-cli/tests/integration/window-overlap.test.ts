import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile, doneCriteriaFor } from '../support/test-helpers.js';

/**
 * End-to-end: the segment-refined claims partition on REAL
 * git trees, driven through the CLI: two concurrent checkpoints on one
 * artifact in one worktree, no locks, no declared-file scopes.
 *
 * Engine proof (plan §Verification): disjoint parallel work → clean
 * manifests with NO reliance on self-report (a file omitted from
 * files_changed but changed in an exclusive segment still attributes);
 * a deliberately concurrent same-file claim → flagged ambiguous in
 * close output + why downgrade + diff --attribution weak-marking +
 * reconcile ambiguous-coverage disclosure; an unclaimed in-window edit
 * → loud warning at the last close; `fingerprint derive` verifies
 * CLEAN on a partitioned checkpoint (the removal replay — no false
 * drift).
 */

interface CloseEnvelope {
  n: number;
  warnings?: Array<{ code: string; message: string }>;
}

interface WindowOverlapOut {
  siblings: number[];
  pending: boolean;
  dropped_files: Array<{ file_before: string | null; file_after: string | null; status: string }>;
  rejected_claims: string[];
  ambiguous_files: Array<{ file_before: string | null; file_after: string | null }>;
  mixed_segment: Array<{ file_before: string | null; file_after: string | null }>;
  own_claim_pending: Array<{ file_before: string | null; file_after: string | null }>;
  segment_attributed: string[];
  unattributed_in_window: string[];
}

// Each workflow performs multiple durable Git publications under coverage.
describe('window overlap — CLI end-to-end', { timeout: 20_000 }, () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let dataRoot: string;

  const repoTemplate = createRepoTemplate(async () => undefined, { initialBranch: 'main' });

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-overlap-history-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const init = await agent.runRaw(['init', '--json', '--no-llm']);
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    try {
      await repo.cleanup();
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  async function capturePlan(): Promise<{ artifactId: string; stepIds: string[] }> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'overlap fixture',
          label: `overlap-${randomUUID().slice(0, 8)}`,
          plan_steps: [
            {
              text: 'step 1',
              label: 's1',
              acceptance_criteria: [{ text: 'the step is delivered' }],
            },
            {
              text: 'step 2',
              label: 's2',
              acceptance_criteria: [{ text: 'the step is delivered' }],
            },
          ],
          touched_scope: [],
        })
      ),
    ]);
    expect(pr.exitCode).toBe(0);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string; acceptance_criteria: Array<{ criterion_id: string }> }>;
    };
    planSteps = plan.plan_steps;
    return { artifactId: plan.artifact_id, stepIds: plan.plan_steps.map((s) => s.step_id) };
  }

  /** Captured rubric, so a close can cite evidence for the step it claims. */
  let planSteps: Array<{ step_id: string; acceptance_criteria: Array<{ criterion_id: string }> }> =
    [];

  async function openCp(artifactId: string, stepId: string): Promise<void> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
  }

  async function closeCp(
    artifactId: string,
    n: number,
    filesChanged: string[],
    stepId: string
  ): Promise<CloseEnvelope> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: artifactId,
          n,
          summary: `cp${n}`,
          files_changed: filesChanged,
          verification: [{ command: 'test fixture', exit_code: 0 }],
          done_criteria: doneCriteriaFor(planSteps, [stepId]),
          completed_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode, `close cp${n} failed: ${r.stdout} ${r.stderr}`).toBe(0);
    return JSON.parse(r.stdout) as CloseEnvelope;
  }

  async function readCheckpoint(artifactId: string, n: number) {
    const scope = await resolveDatabaseHistoryScope({
      cwd: repo.path,
      root: dataRoot,
      profile: 'exact',
      selector: {},
    });
    try {
      const database = scope.projects[0]?.database;
      if (!scope.completeness.complete || !database) throw new Error('Fixture history unavailable');
      const checkpoint = readProjectArtifact(database, artifactId)?.thread.checkpoints.find(
        (candidate) => candidate.n === n
      );
      if (checkpoint?.status !== 'closed')
        throw new Error(`Closed fixture checkpoint ${n} unavailable`);
      return checkpoint;
    } finally {
      scope.close();
    }
  }

  async function readCheckpointOverlap(
    artifactId: string,
    n: number
  ): Promise<WindowOverlapOut | undefined> {
    return (await readCheckpoint(artifactId, n)).window_overlap as WindowOverlapOut | undefined;
  }

  it('disjoint parallel work: clean partition, segment attribution without self-report, derive CLEAN, reconcile covered', async () => {
    const { artifactId, stepIds } = await capturePlan();

    await openCp(artifactId, stepIds[0]); // cp1
    await commitFile(repo.path, 'a.ts', 'export const a = 1;\n', 'agent1 exclusive work');
    await openCp(artifactId, stepIds[1]); // cp2 — window overlap begins
    await commitFile(repo.path, 'b.ts', 'export const b = 2;\n', 'agent2 concurrent work');

    // cp1 closes claiming only its own file. Its fence contains BOTH
    // a.ts (exclusive-1 segment) and b.ts (concurrent segment).
    const close1 = await closeCp(artifactId, 1, ['a.ts'], stepIds[0]);
    const wo1 = await readCheckpointOverlap(artifactId, 1);
    expect(wo1).toBeDefined();
    expect(wo1?.siblings).toEqual([2]);
    expect(wo1?.pending).toBe(true);
    expect(wo1?.dropped_files).toEqual([
      { file_before: null, file_after: 'b.ts', status: 'sibling_pending' },
    ]);
    expect(wo1?.ambiguous_files).toEqual([]);
    // No loud warnings for a clean disjoint close (pending drop is not loud).
    const loud1 = (close1.warnings ?? []).filter((w) => w.code.startsWith('window-overlap'));
    expect(loud1).toEqual([]);

    // c.ts lands in cp2's EXCLUSIVE segment (after cp1 closed) and is
    // deliberately OMITTED from cp2's files_changed — the
    // under-reported-exclusive-owner case.
    await commitFile(repo.path, 'c.ts', 'export const c = 3;\n', 'agent2 forgot to report this');
    const close2 = await closeCp(artifactId, 2, ['b.ts'], stepIds[1]);
    const wo2 = await readCheckpointOverlap(artifactId, 2);
    expect(wo2?.pending).toBe(false);
    expect(wo2?.segment_attributed).toEqual(['c.ts']);
    expect(wo2?.dropped_files).toEqual([]);
    expect(wo2?.unattributed_in_window).toEqual([]);
    expect(
      (close2.warnings ?? []).some((w) => w.code === 'window-overlap-unreported-attributed')
    ).toBe(true);

    // fingerprint derive verifies CLEAN on the partitioned cp1 — the
    // recorded removal (b.ts) replays deterministically, no false drift.
    const derive1 = await agent.runRaw([
      'fingerprint',
      'derive',
      '--artifact',
      artifactId,
      '--checkpoint',
      '1',
      '--json',
    ]);
    expect(derive1.exitCode).toBe(0);
    const derived = JSON.parse(derive1.stdout) as { verified: boolean | null };
    expect(derived.verified).toBe(true);

    // diff --reconcile: every in-window commit is covered — a.ts and
    // b.ts via claims+manifests, c.ts via segment attribution alone.
    const rec = await agent.runRaw(['diff', '--reconcile', '--json']);
    expect(rec.exitCode).toBe(0);
    const recOut = JSON.parse(rec.stdout) as {
      window: {
        uncovered_commits: unknown[];
        ambiguous_coverage_commits: unknown[];
        total_commits: number;
      };
    };
    expect(recOut.window.total_commits).toBe(3);
    expect(recOut.window.uncovered_commits).toEqual([]);
    expect(recOut.window.ambiguous_coverage_commits).toEqual([]);
  });

  it('concurrent same-file claims: ambiguity flagged at the later close, why downgraded, attribution weak, reconcile disclosed', async () => {
    const { artifactId, stepIds } = await capturePlan();

    await openCp(artifactId, stepIds[0]);
    await openCp(artifactId, stepIds[1]);
    await commitFile(repo.path, 'shared.ts', 'export const shared = 1;\n', 'concurrent edit');

    const close1 = await closeCp(artifactId, 1, ['shared.ts'], stepIds[0]);
    // First closer cannot see the sibling's claim — own claim pending, kept.
    const wo1 = await readCheckpointOverlap(artifactId, 1);
    expect(wo1?.own_claim_pending).toEqual([{ file_before: null, file_after: 'shared.ts' }]);
    expect(close1.warnings ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'window-overlap-ambiguous' })
    );

    // Read BETWEEN the closes: why reports provisional, not clean.
    const whyPending = await agent.runRaw(['why', 'shared.ts:1', '--json']);
    expect(whyPending.exitCode).toBe(0);
    const pendingOut = JSON.parse(whyPending.stdout) as {
      best: { reasons: string[] } | null;
    };
    expect(pendingOut.best?.reasons.join('\n')).toMatch(/provisional/i);

    const close2 = await closeCp(artifactId, 2, ['shared.ts'], stepIds[1]);
    expect((close2.warnings ?? []).some((w) => w.code === 'window-overlap-ambiguous')).toBe(true);
    const wo2 = await readCheckpointOverlap(artifactId, 2);
    expect(wo2?.ambiguous_files).toEqual([{ file_before: null, file_after: 'shared.ts' }]);

    // Read AFTER both closes: BOTH checkpoints report the file
    // ambiguous — why downgrades one tier with the distinct reason,
    // without any rewrite of cp1's persisted record.
    const whyAfter = await agent.runRaw(['why', 'shared.ts:1', '--all', '--json']);
    expect(whyAfter.exitCode).toBe(0);
    const afterOut = JSON.parse(whyAfter.stdout) as {
      best: null;
      results: Array<{ checkpoint: { n: number } | null; reasons: string[] }>;
    };
    expect(afterOut.best).toBeNull();
    expect(
      afterOut.results.filter(
        (match) => match.checkpoint && match.reasons.some((reason) => /ambiguous/i.test(reason))
      )
    ).toHaveLength(2);

    // diff --attribution: matches on the ambiguous file are weak — the
    // hunk flips to ambiguous, never clean attribution.
    const attr = await agent.runRaw(['diff', '--attribution', '--json']);
    expect(attr.exitCode).toBe(0);
    const attrOut = JSON.parse(attr.stdout) as {
      hunks: Array<{
        file: string | null;
        ambiguous: boolean;
        matches: Array<{ overlap_status?: string }>;
      }> | null;
      disclosure: { overlap_checkpoints: Array<{ checkpoint: string }> };
    };
    const sharedHunks = (attrOut.hunks ?? []).filter((h) => h.file === 'shared.ts');
    expect(sharedHunks.length).toBeGreaterThan(0);
    for (const h of sharedHunks) {
      expect(h.ambiguous).toBe(true);
      expect(h.matches.every((m) => m.overlap_status === 'ambiguous')).toBe(true);
    }
    expect(attrOut.disclosure.overlap_checkpoints).toHaveLength(2);

    // diff --reconcile: the shared commit is covered ONLY by weak
    // evidence — disclosed as ambiguous coverage, never silently clean.
    const rec = await agent.runRaw(['diff', '--reconcile', '--json']);
    expect(rec.exitCode).toBe(0);
    const recOut = JSON.parse(rec.stdout) as {
      window: {
        uncovered_commits: Array<{ sha: string }>;
        ambiguous_coverage_commits: Array<{ weakly_covered_files: string[] }>;
      };
    };
    expect(recOut.window.uncovered_commits).toEqual([]);
    expect(recOut.window.ambiguous_coverage_commits).toHaveLength(1);
    expect(recOut.window.ambiguous_coverage_commits[0].weakly_covered_files).toEqual(['shared.ts']);

    // Digest surfaces the partition per affected checkpoint.
    const digest = await agent.runRaw(['digest', '--artifact', artifactId]);
    expect(digest.exitCode).toBe(0);
    expect(digest.stdout).toContain('Concurrent checkpoint window');
    expect(digest.stdout).toContain('shared.ts');
  });

  it('mixed exclusive/concurrent evidence: kept flagged mixed_segment, weak in consumers, never removed', async () => {
    // cp1 changes both.ts in its exclusive segment AND it is touched
    // concurrently before cp1 closes: mixed evidence — kept in cp1's
    // manifest on segment proof, flagged, weak everywhere downstream.
    // cp2 never claims it, so at cp2's close the file is dropped from
    // cp2's manifest as sibling-claimed (cp1 claims it).
    const { artifactId, stepIds } = await capturePlan();

    await openCp(artifactId, stepIds[0]); // cp1
    await commitFile(repo.path, 'both.ts', 'export const v = 1;\n', 'cp1 exclusive change');
    await openCp(artifactId, stepIds[1]); // cp2
    await commitFile(repo.path, 'both.ts', 'export const v = 2;\n', 'concurrent change');

    const close1 = await closeCp(artifactId, 1, ['both.ts'], stepIds[0]);
    const wo1 = await readCheckpointOverlap(artifactId, 1);
    expect(wo1?.mixed_segment).toEqual([{ file_before: null, file_after: 'both.ts' }]);
    expect(wo1?.dropped_files).toEqual([]); // kept on evidence, never removed
    expect((close1.warnings ?? []).some((w) => w.code === 'window-overlap-mixed-segment')).toBe(
      true
    );

    const close2 = await closeCp(artifactId, 2, [], stepIds[1]);
    expect(close2.n).toBe(2);
    const wo2 = await readCheckpointOverlap(artifactId, 2);
    // cp2's fence sees v1→v2: a MODIFY hunk, so both path identities set.
    expect(wo2?.dropped_files).toEqual([
      { file_before: 'both.ts', file_after: 'both.ts', status: 'sibling-claimed' },
    ]);
    // cp1's mixed-evidence keep survives cp2's close (append-only).
    const wo1After = await readCheckpointOverlap(artifactId, 1);
    expect(wo1After?.mixed_segment).toEqual([{ file_before: null, file_after: 'both.ts' }]);

    // why: cp1's match is downgraded one tier with the mixed_segment
    // reason — weak, never clean.
    const why = await agent.runRaw(['why', 'both.ts:1', '--all', '--json']);
    expect(why.exitCode).toBe(0);
    const whyOut = JSON.parse(why.stdout) as {
      results: Array<{
        checkpoint: { n: number } | null;
        confidence: string;
        reasons: string[];
      }>;
    };
    const cp1Match = whyOut.results.find((match) => match.checkpoint?.n === 1);
    expect(cp1Match).toBeDefined();
    expect(cp1Match?.confidence).toBe('weak');
    expect(cp1Match?.reasons.join('\n')).toMatch(/ambiguous/i);

    // diff --attribution: every match on the mixed file is weak — the
    // hunk flips to ambiguous, never clean attribution.
    const attr = await agent.runRaw(['diff', '--attribution', '--json']);
    expect(attr.exitCode).toBe(0);
    const attrOut = JSON.parse(attr.stdout) as {
      hunks: Array<{
        file: string | null;
        ambiguous: boolean;
        matches: Array<{ checkpoint_n: number; overlap_status?: string }>;
      }> | null;
    };
    const bothHunks = (attrOut.hunks ?? []).filter(
      (h) => h.file === 'both.ts' && h.matches.length > 0
    );
    expect(bothHunks.length).toBeGreaterThan(0);
    for (const h of bothHunks) {
      expect(h.ambiguous).toBe(true);
      expect(
        h.matches
          .filter((m) => m.checkpoint_n === 1)
          .every((m) => m.overlap_status === 'mixed_segment')
      ).toBe(true);
    }

    // reconcile: the mixed file provides only WEAK coverage — both
    // commits disclosed as ambiguous coverage, never silently clean.
    const rec = await agent.runRaw(['diff', '--reconcile', '--json']);
    expect(rec.exitCode).toBe(0);
    const recOut = JSON.parse(rec.stdout) as {
      window: {
        uncovered_commits: unknown[];
        ambiguous_coverage_commits: Array<{ weakly_covered_files: string[] }>;
        total_commits: number;
      };
    };
    expect(recOut.window.total_commits).toBe(2);
    expect(recOut.window.uncovered_commits).toEqual([]);
    expect(recOut.window.ambiguous_coverage_commits).toHaveLength(2);

    // digest: the mixed-evidence downgrade is reviewer-visible.
    const digest = await agent.runRaw(['digest', '--artifact', artifactId]);
    expect(digest.exitCode).toBe(0);
    expect(digest.stdout).toContain('mixed exclusive/concurrent evidence');
    expect(digest.stdout).toContain('both.ts');
  });

  it('unclaimed in-window edit: dropped from both manifests, loud warning at the LAST close, reconcile uncovered', async () => {
    const { artifactId, stepIds } = await capturePlan();

    await openCp(artifactId, stepIds[0]);
    await openCp(artifactId, stepIds[1]);
    await commitFile(repo.path, 'claimed1.ts', 'export const one = 1;\n', 'cp1 work');
    await commitFile(
      repo.path,
      'drive-by.ts',
      'export const rogue = true;\n',
      'nobody claims this'
    );

    const close1 = await closeCp(artifactId, 1, ['claimed1.ts'], stepIds[0]);
    // Not loud yet — the sibling could still claim it.
    expect((close1.warnings ?? []).some((w) => w.code === 'window-overlap-unattributed')).toBe(
      false
    );

    const close2 = await closeCp(artifactId, 2, [], stepIds[1]);
    const unattributedWarning = (close2.warnings ?? []).find(
      (w) => w.code === 'window-overlap-unattributed'
    );
    expect(unattributedWarning).toBeDefined();
    expect(unattributedWarning?.message).toContain('drive-by.ts');

    const wo2 = await readCheckpointOverlap(artifactId, 2);
    expect(wo2?.unattributed_in_window).toContain('drive-by.ts');

    // Reconcile reports the smuggled commit as uncovered — dropped from
    // every manifest, claimed by nobody.
    const rec = await agent.runRaw(['diff', '--reconcile', '--json']);
    expect(rec.exitCode).toBe(0);
    const recOut = JSON.parse(rec.stdout) as {
      window: { uncovered_commits: Array<{ uncovered_files: string[] }> };
    };
    expect(recOut.window.uncovered_commits).toHaveLength(1);
    expect(recOut.window.uncovered_commits[0].uncovered_files).toEqual(['drive-by.ts']);
  });

  it('overlap + unmerged index: both records on one close, both warning families, derive verifies the composed replay', async () => {
    const { execFileSync } = await import('node:child_process');
    const forgeConflict = (filePath: string): void => {
      const stageLine = (content: string, stage: number): string => {
        const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
          cwd: repo.path,
          input: content,
          encoding: 'utf8',
        }).trim();
        return `100644 ${sha} ${stage}\t${filePath}`;
      };
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: repo.path,
        input: `${[stageLine('base\n', 1), stageLine('ours\n', 2), stageLine('theirs\n', 3)].join(
          '\n'
        )}\n`,
      });
      execFileSync('sh', ['-c', `cat > "$1"`, 'sh', filePath], {
        cwd: repo.path,
        input: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> theirs\n',
      });
    };
    const { artifactId, stepIds } = await capturePlan();

    await openCp(artifactId, stepIds[0]); // cp1
    await commitFile(repo.path, 'a.ts', 'export const a = 1;\n', 'cp1 exclusive work');
    await openCp(artifactId, stepIds[1]); // cp2 — overlap window begins
    await commitFile(repo.path, 'b.ts', 'export const b = 1;\n', 'cp2 concurrent work');
    await commitFile(repo.path, 'shared.ts', 'export const s = 1;\n', 'both claim this');
    forgeConflict('conflict.txt');
    forgeConflict('shared.ts');

    // cp1 closes under BOTH an overlap and an unmerged index.
    const close1 = await closeCp(artifactId, 1, ['a.ts', 'shared.ts'], stepIds[0]);
    expect((close1.warnings ?? []).some((w) => w.code === 'unmerged-paths-degraded')).toBe(true);
    const wo1 = await readCheckpointOverlap(artifactId, 1);
    expect(wo1).toBeDefined();
    expect(wo1?.pending).toBe(true);
    expect(wo1?.dropped_files.some((d) => d.file_after === 'b.ts')).toBe(true);
    expect((await readCheckpoint(artifactId, 1)).attribution_degraded).toEqual({
      unmerged_paths: ['conflict.txt', 'shared.ts'],
    });
    // An unclaimed conflicted path is degraded, never "unattributed in window".
    expect(wo1?.unattributed_in_window).not.toContain('conflict.txt');

    // cp2 closes with the conflict still unresolved: the symmetric shared.ts
    // claim goes ambiguous (overlap family) alongside its own degraded record.
    const close2 = await closeCp(artifactId, 2, ['b.ts', 'shared.ts'], stepIds[1]);
    expect((close2.warnings ?? []).some((w) => w.code === 'window-overlap-ambiguous')).toBe(true);
    expect((close2.warnings ?? []).some((w) => w.code === 'unmerged-paths-degraded')).toBe(true);
    expect((await readCheckpoint(artifactId, 2)).attribution_degraded).toEqual({
      unmerged_paths: ['conflict.txt', 'shared.ts'],
    });

    const why = await agent.runRaw(['why', 'shared.ts']);
    expect(why.exitCode).toBe(0);
    expect(why.stdout).toContain('Overlapping checkpoint claims make attribution ambiguous');
    expect(why.stdout).toContain('Checkpoint boundary attribution is degraded');

    const expandedWhy = await agent.runRaw(['why', 'shared.ts', '--all']);
    expect(expandedWhy.exitCode).toBe(0);
    expect(expandedWhy.stdout).toContain(
      'Overlapping checkpoint claims make attribution ambiguous'
    );
    expect(expandedWhy.stdout).toContain('Checkpoint boundary attribution is degraded');
    expect(expandedWhy.stdout).toContain('overlap fixture');

    // The composed replay (overlap removals + degraded exclusion) reproduces
    // both stored hashes.
    for (const n of [1, 2]) {
      const dr = await agent.runRaw([
        'fingerprint',
        'derive',
        '--artifact',
        artifactId,
        '--checkpoint',
        String(n),
        '--json',
      ]);
      expect(dr.exitCode).toBe(0);
      expect((JSON.parse(dr.stdout) as { verified: boolean | null }).verified).toBe(true);
    }
  });
});
