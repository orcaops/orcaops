import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { buildContextBlock, EvaluatorContextSchema } from '@orcaops/evaluator-protocol';
import { getDefaultConfig } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';

import { databaseEvaluatorStore } from './database-evaluators.js';
import { buildEvaluatorContext, type LifecycleEvaluatorContext } from './evaluator-bridge.js';
import { fixture } from '../../tests/helpers/database-history.js';

describe('buildEvaluatorContext — observed changed files at checkpoint close', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let ctx: LifecycleEvaluatorContext;
  let snapshotTrees: { open: string | null; close: string | null };

  const artifactId = '01999999-9999-7000-8000-00000000000c';
  const STEP_A = '01HX0K8N6ZQF8M5R2V8DZ7T3KA';

  function tree(files: Record<string, string>): string {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(f.temporary, `index-${randomUUID()}`) };
    const git = (args: string[], input?: string): string =>
      execFileSync('git', args, { cwd: f.main, env, input, encoding: 'utf8' }).trim();
    for (const [filePath, content] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], content);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${filePath}`]);
    }
    return git(['write-tree']);
  }

  beforeEach(async () => {
    f = await fixture();
    snapshotTrees = { open: null, close: null };
    ctx = {
      repoRoot: f.main,
      repo: new Repo(f.main),
      config: getDefaultConfig(),
      get store() {
        const store = databaseEvaluatorStore(readProjectArtifact(f.writer, artifactId)!.thread);
        return {
          ...store,
          readCheckpoints: async (id: string) =>
            (await store.readCheckpoints(id)).map((cp) =>
              cp.status === 'closed'
                ? {
                    ...cp,
                    open_snapshot: { ...cp.open_snapshot, tree_sha: snapshotTrees.open },
                    close_snapshot: { ...cp.close_snapshot, tree_sha: snapshotTrees.close },
                  }
                : cp
            ),
        };
      },
    };
    await f.capture(artifactId, {
      ts: '2026-04-26T12:00:00.000Z',
      nonGoals: [
        {
          text: 'do not change scripts/camera/free_camera.gd',
          rationale: 'camera tuning is a separate task',
          source_refs: [],
        },
      ],
      steps: [
        {
          step_id: STEP_A,
          text: 'document camera controls',
          label: 'readme',
          acceptance_criteria: [],
        },
      ],
    });
    await f.mutate(artifactId, {}, (semantics) =>
      semantics.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: [STEP_A] },
        { idempotencyKey: 'open-key', headSha: 'cafef00d' }
      )
    );
    await f.mutate(artifactId, {}, (semantics) =>
      semantics.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: 1,
          summary: 'documented camera controls',
          files_changed: ['README.md'],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          completed_step_ids: [],
          head_sha: 'cafef00d',
        },
        { idempotencyKey: 'close-key' }
      )
    );
  });

  it('carries a changed path the agent did not report into the non-goals context', async () => {
    snapshotTrees = {
      open: tree({ 'README.md': '# Game\n', 'scripts/camera/free_camera.gd': 'fly_speed = 2.0\n' }),
      close: tree({
        'README.md': '# Game\n## Camera controls\n',
        'scripts/camera/free_camera.gd': 'fly_speed = 9.0\n',
      }),
    };

    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'checkpoint-close',
      checkpointN: 1,
    });

    expect(evalCtx.changed_files).toEqual(['README.md']);
    expect(evalCtx.observed_changed_files).toEqual(['README.md', 'scripts/camera/free_camera.gd']);
    const block = buildContextBlock(EvaluatorContextSchema.parse(evalCtx), []);
    expect(block).toContain(
      'Observed but NOT reported by the agent:\n  - scripts/camera/free_camera.gd'
    );
    expect(block).toContain('do not change scripts/camera/free_camera.gd');
  });

  it('names an unreported non-ASCII path exactly as it appears in the tree', async () => {
    snapshotTrees = {
      open: tree({ 'README.md': '# Game\n' }),
      close: tree({ 'README.md': '# Game\n', 'docs/café.md': 'bonjour\n' }),
    };

    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'checkpoint-close',
      checkpointN: 1,
    });

    expect(evalCtx.observed_changed_files).toEqual(['docs/café.md']);
    const block = buildContextBlock(EvaluatorContextSchema.parse(evalCtx), []);
    expect(block).toContain('Observed but NOT reported by the agent:\n  - docs/café.md');
  });

  it('omits observed_changed_files when a snapshot tree is missing', async () => {
    snapshotTrees = { open: null, close: tree({ 'README.md': '# Game\n' }) };

    const evalCtx = await buildEvaluatorContext({
      ctx,
      artifactId,
      firesAt: 'checkpoint-close',
      checkpointN: 1,
    });

    expect('observed_changed_files' in evalCtx).toBe(false);
  });

  it('omits observed_changed_files outside checkpoint close', async () => {
    snapshotTrees = { open: tree({ 'README.md': 'a\n' }), close: tree({ 'README.md': 'b\n' }) };

    const evalCtx = await buildEvaluatorContext({ ctx, artifactId, firesAt: 'pre-pr' });

    expect('observed_changed_files' in evalCtx).toBe(false);
  });
});
