import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactDraftSemantics,
  type ArtifactThread,
  prepareArtifactDraft,
  reconstructArtifactThread,
  uuidv7,
} from '@orcaops/storage';
import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { buildRepoStateFromSnapshot } from './builder.js';
import { Repo } from '../git/repo.js';

async function commitFile(repoPath: string, file: string, content: string, message: string) {
  const full = path.join(repoPath, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  const git = gitClient(repoPath);
  await git.add(file);
  await git.commit(message);
  return (await git.revparse(['HEAD'])).trim();
}

type SeedContext = {
  artifactId: string;
  stepIds: string[];
  semantics: ArtifactDraftSemantics;
};

async function prepareThread(
  baseSha: string,
  seed?: (context: SeedContext) => Promise<void>
): Promise<ArtifactThread> {
  const artifactId = uuidv7();
  const stepIds = [uuidv7(), uuidv7()];
  const prepared = await prepareArtifactDraft(
    {
      artifactId,
      priorEvents: [],
      authoredPayload: {},
      secretAllow: [],
      idempotencyBlocks: [],
    },
    async (semantics) => {
      await semantics.writePlan(
        {
          schema_version: 4,
          artifact_id: artifactId,
          branch: 'main',
          base_sha: baseSha,
          agent: 'codex',
          agent_session_id: null,
          task: 'Inspect repository state',
          label: 'Repository state',
          plan_steps: stepIds.map((stepId, index) => ({
            step_id: stepId,
            text: `Complete work ${index + 1}`,
            label: `Step ${index + 1}`,
            acceptance_criteria: [],
          })),
          touched_scope: [],
          started_at: '2026-04-25T12:00:00.000Z',
          non_goals: [],
          decisions: [],
          revision_n: 0,
          revised_at: null,
          rationale: null,
          step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
          prior_plan_event_id: null,
          criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        },
        { idempotencyKey: `plan-${artifactId}` }
      );
      await seed?.({ artifactId, stepIds, semantics });
    }
  );
  if (prepared.evaluation.kind === 'threw') throw prepared.evaluation.error;
  return reconstructArtifactThread(
    artifactId,
    prepared.events.map((event) => ({
      record: event.record,
      payload: JSON.parse(event.payloadBytes.toString('utf8')),
    }))
  );
}

async function closeCheckpoint(context: SeedContext, n: number, headSha: string, files: string[]) {
  await context.semantics.writeCheckpointOpened(
    { artifact_id: context.artifactId, declared_step_ids: [context.stepIds[n - 1]!] },
    { idempotencyKey: `open-${n}`, headSha }
  );
  await context.semantics.writeCheckpointClosed(
    {
      artifact_id: context.artifactId,
      n,
      summary: `Checkpoint ${n}`,
      files_changed: files,
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      verification: [{ command: `pnpm test checkpoint-${n}`, exit_code: 0 }],
      completed_step_ids: [context.stepIds[n - 1]!],
      head_sha: headSha,
    },
    { idempotencyKey: `close-${n}` }
  );
}

async function summarize(context: SeedContext, headSha: string, openItems: string[]) {
  await context.semantics.writeSummary({
    schema_version: 1,
    artifact_id: context.artifactId,
    outcome: 'Delivered retained work',
    tests_written: [],
    tests_run: [],
    open_items: openItems,
    deferred_decisions: [],
    head_sha: headSha,
    ts: '2026-04-25T14:00:00.000Z',
  });
}

describe('buildRepoStateFromSnapshot', () => {
  let tempRepo: TempRepo;
  let repo: Repo;

  beforeEach(async () => {
    tempRepo = await createTempRepo({ initialBranch: 'main' });
    repo = new Repo(tempRepo.path);
  });

  afterEach(async () => {
    await tempRepo.cleanup();
  });

  function build(
    thread: ArtifactThread,
    laterArtifactEvidence: { artifact_id: string; files: string[] } | null = null,
    options: { workingTreeStatusMaxLines?: number; strictGit?: boolean } = {}
  ) {
    return buildRepoStateFromSnapshot({
      repo,
      artifactId: thread.artifactId,
      snapshot: {
        plan: thread.plan,
        checkpoints: thread.checkpoints,
        summary: thread.summary,
      },
      laterArtifactEvidence,
      ...options,
    });
  }

  it('returns null for a snapshot without a plan', async () => {
    const head = await repo.getHeadSha();
    const thread = await prepareThread(head);
    expect(
      await buildRepoStateFromSnapshot({
        repo,
        artifactId: thread.artifactId,
        snapshot: { plan: null, checkpoints: [], summary: null },
        laterArtifactEvidence: null,
      })
    ).toBeNull();
  });

  it('uses plan, last checkpoint, then summary as the artifact head', async () => {
    const initial = await repo.getHeadSha();
    const planned = await prepareThread(initial);
    expect((await build(planned))?.artifact_head_sha).toBe(initial);

    const checkpointed = await prepareThread(initial, async (context) => {
      await closeCheckpoint(context, 1, 'b'.repeat(40), ['src/a.ts']);
      await closeCheckpoint(context, 2, 'c'.repeat(40), ['src/b.ts']);
    });
    expect((await build(checkpointed))?.artifact_head_sha).toBe('c'.repeat(40));

    const summarized = await prepareThread(initial, async (context) => {
      await closeCheckpoint(context, 1, 'b'.repeat(40), ['src/a.ts']);
      await summarize(context, 'd'.repeat(40), []);
    });
    expect((await build(summarized))?.artifact_head_sha).toBe('d'.repeat(40));
  });

  it('reports clean and dirty working trees and caps status lines', async () => {
    const thread = await prepareThread(await repo.getHeadSha());
    expect(await build(thread)).toMatchObject({
      current_branch: 'main',
      working_tree_dirty: false,
      working_tree_status: '',
      head_matches_artifact: true,
    });
    for (let index = 0; index < 5; index++) {
      await writeFile(path.join(tempRepo.path, `untracked-${index}.ts`), 'x\n');
    }
    const dirty = await build(thread, null, { workingTreeStatusMaxLines: 2 });
    expect(dirty?.working_tree_dirty).toBe(true);
    expect(dirty?.working_tree_status.split('\n')).toHaveLength(3);
    expect(dirty?.working_tree_status).toContain('more lines');
  });

  it('selects only in-range commits that touch retained artifact files', async () => {
    await commitFile(tempRepo.path, 'src/a.ts', 'initial\n', 'add a');
    const checkpointHead = await repo.getHeadSha();
    const thread = await prepareThread(checkpointHead, async (context) => {
      await closeCheckpoint(context, 1, checkpointHead, ['src/a.ts']);
    });
    const changedSha = await commitFile(tempRepo.path, 'src/a.ts', 'changed\n', 'modify a');
    await commitFile(tempRepo.path, 'src/unrelated.ts', 'new\n', 'add unrelated');
    repo = new Repo(tempRepo.path);

    expect((await build(thread))?.commits_since_artifact_head_touching_artifact_files).toEqual([
      { sha: changedSha, subject: 'modify a', files: ['src/a.ts'] },
    ]);
  });

  it('gives changed-file evidence precedence for every open item', async () => {
    await commitFile(tempRepo.path, 'src/a.ts', 'initial\n', 'add a');
    const checkpointHead = await repo.getHeadSha();
    const thread = await prepareThread(checkpointHead, async (context) => {
      await closeCheckpoint(context, 1, checkpointHead, ['src/a.ts']);
      await summarize(context, checkpointHead, ['Wire retries', 'Document edge cases']);
    });
    await commitFile(tempRepo.path, 'src/a.ts', 'changed\n', 'follow-up');
    repo = new Repo(tempRepo.path);

    const state = await build(thread, { artifact_id: uuidv7(), files: ['src/a.ts'] });
    expect(state?.open_items_addressed_since).toEqual([
      { item: 'Wire retries', evidence: { kind: 'file_changed', files: ['src/a.ts'] } },
      { item: 'Document edge cases', evidence: { kind: 'file_changed', files: ['src/a.ts'] } },
    ]);
  });

  it('uses explicitly selected later-artifact evidence when Git has no matching change', async () => {
    await commitFile(tempRepo.path, 'src/a.ts', 'initial\n', 'add a');
    const checkpointHead = await repo.getHeadSha();
    const thread = await prepareThread(checkpointHead, async (context) => {
      await closeCheckpoint(context, 1, checkpointHead, ['src/a.ts']);
      await summarize(context, checkpointHead, ['Wire retries']);
    });
    const selected = { artifact_id: uuidv7(), files: ['src/a.ts'] };
    expect((await build(thread, selected))?.open_items_addressed_since).toEqual([
      { item: 'Wire retries', evidence: { kind: 'later_artifact', ...selected } },
    ]);
  });

  it('does not invent evidence without artifact files or open items', async () => {
    const head = await repo.getHeadSha();
    const noFiles = await prepareThread(head, async (context) => {
      await summarize(context, head, ['Wire retries']);
    });
    expect(
      (await build(noFiles, { artifact_id: uuidv7(), files: ['src/a.ts'] }))
        ?.open_items_addressed_since
    ).toEqual([]);

    const noItems = await prepareThread(head, async (context) => {
      await closeCheckpoint(context, 1, head, ['src/a.ts']);
      await summarize(context, head, []);
    });
    expect(
      (await build(noItems, { artifact_id: uuidv7(), files: ['src/a.ts'] }))
        ?.open_items_addressed_since
    ).toEqual([]);
  });

  it('skips range reads when the artifact head matches or no files are retained', async () => {
    const head = await repo.getHeadSha();
    const getCommits = vi.spyOn(repo, 'getCommitsBetween');
    const planned = await prepareThread(head);
    await build(planned);
    expect(getCommits).not.toHaveBeenCalled();

    await commitFile(tempRepo.path, 'src/a.ts', 'new\n', 'new commit');
    repo = new Repo(tempRepo.path);
    const noFileRange = vi.spyOn(repo, 'getCommitsBetween');
    await build(planned);
    expect(noFileRange).not.toHaveBeenCalled();
  });

  it('uses strict Git traversal when requested', async () => {
    await commitFile(tempRepo.path, 'src/a.ts', 'initial\n', 'add a');
    const checkpointHead = await repo.getHeadSha();
    const thread = await prepareThread(checkpointHead, async (context) => {
      await closeCheckpoint(context, 1, checkpointHead, ['src/a.ts']);
    });
    await commitFile(tempRepo.path, 'src/a.ts', 'changed\n', 'modify a');
    repo = new Repo(tempRepo.path);
    const strict = vi.spyOn(repo, 'getCommitsBetweenStrict');
    const tolerant = vi.spyOn(repo, 'getCommitsBetween');
    await build(thread, null, { strictGit: true });
    expect(strict).toHaveBeenCalledWith(checkpointHead, await repo.getHeadSha());
    expect(tolerant).not.toHaveBeenCalled();
  });
});
