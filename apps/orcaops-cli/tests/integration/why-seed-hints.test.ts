import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { ArtifactStore, uuidv7 } from '@orcaops/storage';
import { createHistoryRepo, type HistoryRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Weak-match discovery hints: a weak `why` match is file-overlap evidence,
 * not authorship, so the seed door stays open beside it whenever the blame
 * commit's cluster is not imported — including the decline-aware variant.
 */
describe('orcaops why weak-match seed hints', () => {
  let repo: HistoryRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the service',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: stabilize the service',
        files: { 'src/health.ts': 'export const healthy = true;\n' },
      },
    ]);
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /**
   * One imported thread whose closed checkpoint claims `files` at
   * `headSha`, with the artifact based at `baseSha` — a blame commit that
   * is an ancestor of BOTH resolves as a weak "pre-existing context" match.
   */
  async function writeImportedThread(opts: {
    baseSha: string;
    headSha: string;
    files: string[];
  }): Promise<void> {
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      const artifactId = uuidv7();
      const stepId = uuidv7();
      const ts = '2025-06-01T00:00:00.000Z';
      const { event_id } = await store.writePlan({
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'origin/main',
        base_sha: opts.baseSha,
        agent: 'other',
        agent_session_id: null,
        task: 'Imported thread claiming the service file',
        label: 'Imported service thread',
        plan_steps: [
          {
            step_id: stepId,
            text: 'Land the change',
            label: 'Land the change',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        origin: {
          kind: 'git-import',
          imported_at: ts,
          tool_version: 'test',
          source_range: `${opts.baseSha}..${opts.headSha}`,
          authors: ['test@orcaops.local'],
          enriched_at: null,
        },
        started_at: ts,
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      });
      const opened = await store.writeCheckpointOpened(
        {
          artifact_id: artifactId,
          declared_step_ids: [stepId],
          policy_exceptions: [],
          plan_revision_id: event_id,
        },
        { headSha: opts.baseSha, openedAt: ts, invokedByAgent: 'other', idempotencyKey: uuidv7() }
      );
      if (opened.outcome === 'conflict' || opened.outcome === 'blocked') {
        throw new Error('checkpoint open failed');
      }
      await store.writeCheckpointClosed(
        {
          artifact_id: artifactId,
          n: opened.checkpoint.n,
          summary: 'Landed the imported change',
          files_changed: opts.files,
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
          head_sha: opts.headSha,
        },
        {
          closedAt: ts,
          invokedByAgent: 'other',
          skipWallClockOverlapScan: true,
          idempotencyKey: uuidv7(),
        }
      );
      await store.writeSummary({
        schema_version: 1,
        artifact_id: artifactId,
        agent: 'other',
        outcome: 'Landed the imported change',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: opts.headSha,
        ts,
      });
    } finally {
      store.close();
    }
  }

  it('appends the seed hint to a weak match on an un-imported blame cluster', async () => {
    await writeImportedThread({
      baseSha: repo.shas.next!,
      headSha: repo.shas.next!,
      files: ['src/service.ts'],
    });

    const result = await agent.runRaw(['why', 'src/service.ts:1', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      blame_sha: string;
      best: { confidence: string } | null;
      hint?: string;
    };
    expect(payload.blame_sha).toBe(repo.shas.root);
    expect(payload.best?.confidence).toBe('weak');
    expect(payload.hint).toBe(
      `weak match only — the authoring cluster isn't imported; ` +
        `\`orcaops seed --commit ${repo.shas.root}\` will import it`
    );

    const human = (await agent.runRaw(['why', 'src/service.ts:1'])).stdout;
    expect(human).toContain('** best match **');
    expect(human).toContain("weak match only — the authoring cluster isn't imported");
  });

  it('stays quiet on a weak match whose blame commit an import covers', async () => {
    await writeImportedThread({
      baseSha: repo.shas.next!,
      headSha: repo.shas.next!,
      files: ['src/service.ts'],
    });
    // A second imported thread recorded the blame commit as a checkpoint
    // head (different file, so it never becomes a candidate match).
    await writeImportedThread({
      baseSha: repo.shas.root!,
      headSha: repo.shas.root!,
      files: ['docs/notes.md'],
    });

    const result = await agent.runRaw(['why', 'src/service.ts:1', '--json']);
    const payload = JSON.parse(result.stdout) as {
      best: { confidence: string } | null;
      hint?: string;
    };
    expect(payload.best?.confidence).toBe('weak');
    expect(payload.hint).toBeUndefined();
  });

  it('keeps the weak hint decline-aware', async () => {
    await writeImportedThread({
      baseSha: repo.shas.next!,
      headSha: repo.shas.next!,
      files: ['src/service.ts'],
    });
    await agent.runRaw(['seed', 'status', '--decline', './src/', '--json']);

    const result = await agent.runRaw(['why', 'src/service.ts:1', '--json']);
    const payload = JSON.parse(result.stdout) as { hint?: string };
    expect(payload.hint).toBe(
      `weak match only — the authoring cluster isn't imported; imports for src ` +
        `were declined — re-enable with \`orcaops seed status --offer-again src\``
    );
    expect(payload.hint).not.toContain('seed --commit');
  });
});
