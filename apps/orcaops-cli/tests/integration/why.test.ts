import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

// parseTarget pure-helper tests live in src/commands/why.test.ts.
// This file covers integration behavior — blame walks, --all and
// --branch flags, file-with-colon round-trip end-to-end.

describe('orcaops why — integration (flag matrix + blame)', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('file:line where file contains a colon round-trips through the action (LAST colon split)', async () => {
    await agent.init({ noLlm: true });
    const ok = await agent.why('weird:name.ts:5');
    expect(ok.file).toBe('weird:name.ts');
    expect(ok.line).toBe(5);
    expect(ok.blame_sha).toBeNull();
    expect(ok.best).toBeNull();
  });

  it('--all returns the full all[] candidate list in JSON', async () => {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);

    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await git.add('src/a.ts');
    await git.commit('init', { '--allow-empty': null });
    const sha = (await git.revparse(['HEAD'])).trim();

    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'real cp',
        files_changed: ['src/a.ts'],
      },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        n: 2,
        summary: 'second cp',
        files_changed: ['src/a.ts'],
      },
      { noLlm: true }
    );

    const withoutAll = await agent.why('src/a.ts:1');
    expect(withoutAll.best).not.toBeNull();
    expect(withoutAll.all).toBeUndefined();

    const withAll = await agent.why('src/a.ts:1', { all: true });
    expect(withAll.all).toBeDefined();
    expect(withAll.all?.length).toBeGreaterThanOrEqual(2);
    expect(withAll.all?.[0].confidence).toBe('exact');
    for (const m of withAll.all ?? []) {
      expect(m.checkpoint_head_sha).toBe(sha);
    }
  });

  it('refuses attribution when the matched artifact is unreadable (no clean answer from rot)', async () => {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await git.add('src/a.ts');
    await git.commit('init', { '--allow-empty': null });

    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'real cp',
        files_changed: ['src/a.ts'],
      },
      { noLlm: true }
    );

    // Rot the close line: SQLite still holds the match rows, but the
    // event log cannot be read — `why` is a provenance resolution
    // surface and must refuse rather than serve a clean attribution.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');

    const res = await agent.runRaw(['why', 'src/a.ts:1', '--json']);
    expect(res.exitCode).not.toBe(0);
    const out = JSON.parse(res.stdout) as { error: { message: string } };
    expect(out.error.message).toMatch(/corrupt event-log line|unreadable/);
  });

  it('human output renders rejected alternatives for plan + checkpoint decisions', async () => {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await git.add('src/a.ts');
    await git.commit('init', { '--allow-empty': null });

    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      {
        task: 't',
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: [],
        decisions: [
          {
            decision: 'imperative enqueueCommand',
            reason: 'atomic with the write',
            alternatives_considered: [
              { option: 'event-listener trigger', rejected_because: 'async double-dispatch' },
            ],
          },
        ],
      },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'wrote a.ts',
        files_changed: ['src/a.ts'],
        decisions: [
          {
            decision: 'return 429 on limit',
            reason: 'standard rate-limit status',
            alternatives_considered: [{ option: '503', rejected_because: 'wrong semantics' }],
          },
        ],
      },
      { noLlm: true }
    );

    // Human output (no --json) must surface the rejected alternatives — the
    // provenance `why` must surface.
    const res = await agent.runRaw(['why', 'src/a.ts:1']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      'considered event-listener trigger — rejected because async double-dispatch'
    );
    expect(res.stdout).toContain('considered 503 — rejected because wrong semantics');
  });

  it("--all renders an artifact's plan decisions once per open-revision (deduped, precise rev label)", async () => {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await git.add('src/a.ts');
    await git.commit('init', { '--allow-empty': null });

    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      {
        task: 't',
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: [],
        decisions: [{ decision: 'imperative enqueueCommand', reason: 'atomic with the write' }],
      },
      { noLlm: true }
    );
    // Two checkpoints of the SAME artifact both touch src/a.ts (claim nothing →
    // no open-cp overlap) so --all surfaces both as candidates.
    await agent.captureCheckpoint(
      { artifact_id: plan.artifact_id, n: 1, summary: 'cp1', files_changed: ['src/a.ts'] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      { artifact_id: plan.artifact_id, n: 2, summary: 'cp2', files_changed: ['src/a.ts'] },
      { noLlm: true }
    );

    const res = await agent.runRaw(['why', 'src/a.ts:1', '--all']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Other candidates'); // two matches of one artifact
    // Both checkpoints opened at the SAME plan revision (0), so their plan-decision
    // slice is identical and the block renders exactly ONCE (deduped per
    // (artifact, open-revision)), with the precise "plan rev 0" label.
    expect((res.stdout.match(/decision \(plan rev 0\)/g) ?? []).length).toBe(1);
  });

  it('--branch narrows candidates to one branch', async () => {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);

    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'shared.ts'), 'export const x = 1;\n', 'utf8');
    await git.add('src/shared.ts');
    await git.commit('add shared', { '--allow-empty': null });
    const sha = (await git.revparse(['HEAD'])).trim();

    await agent.init({ noLlm: true });

    const onMain = await agent.capturePlan(
      { task: 'main work', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: onMain.artifact_id,
        n: 1,
        summary: 'main cp',
        files_changed: ['src/shared.ts'],
      },
      { noLlm: true }
    );

    await git.checkoutBranch('feat/x', 'main');
    const onFeat = await agent.capturePlan(
      { task: 'feat work', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: onFeat.artifact_id,
        n: 1,
        summary: 'feat cp',
        files_changed: ['src/shared.ts'],
      },
      { noLlm: true }
    );

    const both = await agent.why('src/shared.ts:1', { all: true });
    expect(both.all?.length).toBe(2);

    const onlyMain = await agent.why('src/shared.ts:1', { all: true, branch: 'main' });
    expect(onlyMain.all?.length).toBe(1);
    expect(onlyMain.all?.[0].branch).toBe('main');
    expect(onlyMain.all?.[0].artifact_id).toBe(onMain.artifact_id);
    expect(onlyMain.all?.[0].checkpoint_head_sha).toBe(sha);
  });

  it('blame returns null for an unknown file → blame_sha:null, best:null', async () => {
    await agent.init({ noLlm: true });
    const r = await agent.why('does/not/exist.ts:1');
    expect(r.blame_sha).toBeNull();
    expect(r.best).toBeNull();
  });
});
