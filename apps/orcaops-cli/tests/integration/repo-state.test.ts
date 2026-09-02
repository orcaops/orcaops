import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

function headlessEnv(): Record<string, string> {
  // Blank out session env vars so resolveShellKey lands on `none` and
  // capture plan's auto-pin path is a no-op. Empty strings count as
  // unset (resolveShellKey's `length > 0` guard).
  return {
    CLAUDE_SESSION_ID: '',
    CODEX_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
  };
}

interface ResumeResolved {
  ok: true;
  resolved: true;
  artifact: {
    artifact_id: string;
    repo_state: {
      current_branch: string;
      current_head_sha: string;
      artifact_head_sha: string | null;
      head_matches_artifact: boolean;
      working_tree_dirty: boolean;
      working_tree_status: string;
      commits_since_artifact_head_touching_artifact_files: Array<{
        sha: string;
        subject: string;
        files: string[];
      }>;
      open_items_addressed_since: Array<{
        item: string;
        evidence: { kind: string; files: string[]; artifact_id?: string };
      }>;
    } | null;
  };
}

interface ShowOk {
  ok: true;
  artifact: {
    id: string;
    repo_state: ResumeResolved['artifact']['repo_state'];
  };
}

describe('repo_state in resume + show', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    await writeFile(path.join(repo.path, '.gitignore'), '.orcaops/\n', 'utf8');
    const git = gitClient(repo.path);
    await git.add('.gitignore');
    await git.commit('add .gitignore');
    agent = makeAgent({ cwd: repo.path, env: headlessEnv() });
    await agent.init({ noLlm: true });
    await git.add('.');
    await git.commit('init artifacts').catch(() => undefined);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function planArtifact(): Promise<string> {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(res.exitCode).toBe(0);
    return (JSON.parse(res.stdout) as { artifact_id: string }).artifact_id;
  }

  async function captureCheckpoint(artifactId: string, n: number, files: string[]): Promise<void> {
    const showRes = await agent.runRaw(['show', artifactId, '--json']);
    const showJson = JSON.parse(showRes.stdout) as {
      artifact?: { plan?: { plan_steps?: Array<{ step_id: string }> } };
    };
    const stepIds = showJson.artifact?.plan?.plan_steps?.map((s) => s.step_id) ?? [];
    const openRes = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          declared_step_ids: [stepIds[n - 1]],
        })
      ),
    ]);
    expect(openRes.exitCode).toBe(0);
    const res = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          n,
          summary: `cp ${n}`,
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepIds[n - 1]],
          files_changed: files,
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
  }

  describe('resume', () => {
    it('emits repo_state with head_matches_artifact=true on a clean tree', async () => {
      const id = await planArtifact();
      const res = await agent.runRaw(['resume', '--artifact', id, '--json']);
      expect(res.exitCode).toBe(0);
      const r = JSON.parse(res.stdout) as ResumeResolved;
      const rs = r.artifact.repo_state;
      expect(rs).not.toBeNull();
      if (!rs) return;
      expect(rs.current_branch).toBe('main');
      expect(rs.head_matches_artifact).toBe(true);
      expect(rs.working_tree_dirty).toBe(false);
      expect(rs.working_tree_status).toBe('');
      expect(rs.commits_since_artifact_head_touching_artifact_files).toEqual([]);
      expect(rs.open_items_addressed_since).toEqual([]);
    });

    it('working_tree_dirty=true when there are untracked files', async () => {
      const id = await planArtifact();
      await writeFile(path.join(repo.path, 'untracked.ts'), 'x\n', 'utf8');
      const res = await agent.runRaw(['resume', '--artifact', id, '--json']);
      const r = JSON.parse(res.stdout) as ResumeResolved;
      expect(r.artifact.repo_state?.working_tree_dirty).toBe(true);
      expect(r.artifact.repo_state?.working_tree_status).toMatch(/\?\?\s+untracked\.ts/);
    });

    it('lists in-range commits that touch checkpoint files_changed', async () => {
      const fileSha = await commitFile(repo.path, 'src/a.ts', 'one\n', 'add src/a.ts');
      const id = await planArtifact();
      await captureCheckpoint(id, 1, ['src/a.ts']);
      await commitFile(repo.path, 'src/a.ts', 'two\n', 'modify src/a.ts');
      await commitFile(repo.path, 'README.md', 'r\n', 'tweak readme');

      const res = await agent.runRaw(['resume', '--artifact', id, '--json']);
      const r = JSON.parse(res.stdout) as ResumeResolved;
      const commits =
        r.artifact.repo_state?.commits_since_artifact_head_touching_artifact_files ?? [];
      expect(commits).toHaveLength(1);
      expect(commits[0].subject).toBe('modify src/a.ts');
      expect(commits[0].files).toEqual(['src/a.ts']);
      void fileSha;
    });

    it('open_items_addressed_since populated when artifact files have moved', async () => {
      await commitFile(repo.path, 'src/a.ts', 'one\n', 'add src/a.ts');
      const id = await planArtifact();
      await captureCheckpoint(id, 1, ['src/a.ts']);
      await agent.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(
          JSON.stringify({
            artifact_id: id,
            outcome: 'shipped',
            open_items: ['Wire retries', 'Add docs'],
          })
        ),
      ]);
      await commitFile(repo.path, 'src/a.ts', 'two\n', 'follow-up tweak');

      const res = await agent.runRaw(['resume', '--artifact', id, '--json']);
      const r = JSON.parse(res.stdout) as ResumeResolved;
      const ev = r.artifact.repo_state?.open_items_addressed_since ?? [];
      expect(ev.map((e) => e.item).sort()).toEqual(['Add docs', 'Wire retries']);
      expect(ev[0].evidence.kind).toBe('file_changed');
    });

    it('human format mentions dirty tree above the resume markdown', async () => {
      const id = await planArtifact();
      await writeFile(path.join(repo.path, 'untracked.ts'), 'x\n', 'utf8');
      const res = await agent.runRaw(['resume', '--artifact', id]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/Repo state: Working tree is dirty\./);
    });

    it('artifact with no checkpoints reports artifact_head_sha = plan.base_sha', async () => {
      const id = await planArtifact();
      const res = await agent.runRaw(['resume', '--artifact', id, '--json']);
      const r = JSON.parse(res.stdout) as ResumeResolved;
      const rs = r.artifact.repo_state;
      expect(rs?.artifact_head_sha).toBe(rs?.current_head_sha);
    });
  });

  describe('show', () => {
    it('emits repo_state in show --json', async () => {
      const id = await planArtifact();
      const res = await agent.runRaw(['show', id, '--json']);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as ShowOk;
      expect(out.artifact.repo_state).not.toBeNull();
      expect(out.artifact.repo_state?.current_branch).toBe('main');
    });

    it('show human format renders a Repo state section', async () => {
      const id = await planArtifact();
      const res = await agent.runRaw(['show', id]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/Repo state:/);
      expect(res.stdout).toMatch(/current_branch=main/);
    });

    it('shows ahead-commit count when there are matching commits', async () => {
      await commitFile(repo.path, 'src/a.ts', 'one\n', 'add src/a.ts');
      const id = await planArtifact();
      await captureCheckpoint(id, 1, ['src/a.ts']);
      await commitFile(repo.path, 'src/a.ts', 'two\n', 'modify src/a.ts');
      const res = await agent.runRaw(['show', id, '--json']);
      const out = JSON.parse(res.stdout) as ShowOk;
      expect(
        out.artifact.repo_state?.commits_since_artifact_head_touching_artifact_files
      ).toHaveLength(1);
    });
  });
});
