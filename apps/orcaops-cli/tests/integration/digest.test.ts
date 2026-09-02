import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('orcaops digest — flag matrix + error envelopes', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function seedThread(): Promise<string> {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1',
        files_changed: ['src/a.ts'],
        completed_step_ids: [plan.plan_steps[0].step_id],
      },
      { noLlm: true }
    );
    await agent.captureSummary({ artifact_id: plan.artifact_id, outcome: 'shipped' });
    return plan.artifact_id;
  }

  it('--out writes the markdown to an arbitrary file (and still caches under the artifact)', async () => {
    const artifactId = await seedThread();
    const outFile = path.join(repo.path, 'pr-digest.md');
    const result = await agent.digest({ out: outFile });
    expect(result.artifact_id).toBe(artifactId);
    expect(result.cached_at).toMatch(/digest\.md$/);
    const onDisk = await readFile(outFile, 'utf8');
    const parsed = JSON.parse(onDisk) as { ok: boolean; data: { artifact_id: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.artifact_id).toBe(artifactId);
  });

  it('--out without --json writes plain markdown to the target file', async () => {
    const artifactId = await seedThread();
    const outFile = path.join(repo.path, 'pr-digest.md');
    const result = await agent.runRaw(['digest', '--format', 'md', '--out', outFile]);
    expect(result.exitCode).toBe(0);
    const md = await readFile(outFile, 'utf8');
    expect(md).toContain(`# digest — \`main\` / \`${artifactId}\``);
    expect(md).toContain('## why');
  });

  it('--artifact <id> selects an explicit artifact rather than the latest', async () => {
    await agent.init({ noLlm: true });
    const a1 = await agent.capturePlan(
      { task: 'first', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const a2 = await agent.capturePlan(
      { task: 'second', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    expect(a1.artifact_id).not.toBe(a2.artifact_id);

    const d1 = await agent.digest({ artifact: a1.artifact_id });
    expect(d1.artifact_id).toBe(a1.artifact_id);
    const d2 = await agent.digest({ artifact: a2.artifact_id });
    expect(d2.artifact_id).toBe(a2.artifact_id);
    const dDefault = await agent.digest();
    expect(dDefault.artifact_id).toBe(a2.artifact_id);
  }, 30_000);

  it('a positional artifact id selects like --artifact and rejects a conflicting pair', async () => {
    const artifactId = await seedThread();
    const positional = JSON.parse(
      (await agent.runRaw(['digest', artifactId, '--json'])).stdout
    ) as {
      ok: boolean;
      artifact_id: string;
    };
    expect(positional).toMatchObject({ ok: true, artifact_id: artifactId });

    const agreeing = JSON.parse(
      (await agent.runRaw(['digest', artifactId, '--artifact', artifactId, '--json'])).stdout
    ) as { ok: boolean; artifact_id: string };
    expect(agreeing).toMatchObject({ ok: true, artifact_id: artifactId });

    const err = await agent.expectError(['digest', artifactId, '--artifact', 'other-id', '--json']);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toContain('Conflicting artifact ids');
  }, 30_000);

  it('default selection prefers the newest SUMMARIZED artifact over a newer in-flight one', async () => {
    // Older artifact completes its lifecycle; a newer one is captured but
    // never summarized. A status-blind default would pick the newer
    // in-flight thread, handing reviewers a digest with no summary.
    const summarized = await seedThread();
    const inFlight = await agent.capturePlan(
      { task: 'newer wip', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );

    const r = await agent.runRaw(['digest', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      artifact_id: string;
      note?: string;
      other_artifacts?: Array<{ id: string; state: string }>;
    };
    expect(out.artifact_id).toBe(summarized);
    expect(out.note).toBeUndefined();
    // The sibling's REAL lifecycle state (planned — captured, no checkpoint
    // yet), not the coarse fold; and strictly one vocabulary.
    expect(out.other_artifacts).toEqual([
      expect.objectContaining({ id: inFlight.artifact_id, state: 'planned' }),
    ]);
    expect(out.other_artifacts![0]).not.toHaveProperty('status');
  }, 30_000);

  it('falls back to the newest ACTIVE artifact with an explicit in-flight note when nothing is summarized', async () => {
    await agent.init({ noLlm: true });
    const a1 = await agent.capturePlan(
      { task: 'only wip', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );

    const r = await agent.runRaw(['digest', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { artifact_id: string; note?: string };
    expect(out.artifact_id).toBe(a1.artifact_id);
    expect(out.note).toContain('in-flight');
    expect(out.note).toContain('no summary');

    // Human output surfaces the same note on stderr, keeping piped
    // markdown clean.
    const human = await agent.runRaw(['digest']);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toContain('in-flight');
    expect(human.stdout).not.toContain('in-flight (no summary');
  }, 30_000);

  it('an unreadable sibling renders state unknown under the marker with its label served', async () => {
    const summarized = await seedThread();
    const sibling = await agent.capturePlan(
      {
        task: 'sibling that rots',
        label: 'rot-sibling',
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: [],
      },
      { noLlm: true }
    );
    // Unattributable non-tail rot: every projection read for it refuses.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', sibling.artifact_id);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"plan_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');
    await rm(path.join(dir, 'artifact.json'), { force: true });
    await rm(path.join(dir, 'plan.json'), { force: true });

    const r = await agent.runRaw(['digest', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      artifact_id: string;
      other_artifacts?: unknown[];
    };
    expect(out.artifact_id).toBe(summarized);
    expect(out.other_artifacts).toEqual([
      {
        id: sibling.artifact_id,
        state: null,
        unreadable: true,
        label: 'rot-sibling',
        origin: null,
      },
    ]);

    const human = await agent.runRaw(['digest']);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toContain(`${sibling.artifact_id.slice(0, 8)} (unreadable)`);
    expect(human.stderr).not.toContain(`${sibling.artifact_id.slice(0, 8)} (null)`);
  }, 30_000);

  it('--artifact bypass emits neither note nor other_artifacts (unchanged contract)', async () => {
    await seedThread();
    const wip = await agent.capturePlan(
      { task: 'wip 2', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const r = await agent.runRaw(['digest', '--artifact', wip.artifact_id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      artifact_id: string;
      note?: string;
      other_artifacts?: unknown[];
    };
    expect(out.artifact_id).toBe(wip.artifact_id);
    expect(out.note).toBeUndefined();
    expect(out.other_artifacts).toBeUndefined();
  }, 30_000);

  it('--branch selects from a specific branch (not the current one)', async () => {
    await agent.init({ noLlm: true });
    const onMain = await agent.capturePlan(
      { task: 'work on main', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );

    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    await git.checkoutBranch('feat/other', 'main');
    await mkdir(path.join(repo.path, 'src'), { recursive: true });
    await writeFile(path.join(repo.path, 'src', 'x.ts'), 'x\n', 'utf8');
    await git.add('src/x.ts');
    await git.commit('on feat/other', { '--allow-empty': null });

    const err = await agent.expectError(['digest', '--json']);
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
    expect(err.error.message).toMatch(/feat\/other/);

    const d = await agent.digest({ branch: 'main' });
    expect(d.artifact_id).toBe(onMain.artifact_id);
  }, 30_000);

  it('returns UNKNOWN_ARTIFACT for an unknown --artifact id', async () => {
    await agent.init({ noLlm: true });
    const err = await agent.expectError(['digest', '--json', '--artifact', 'doesnotexist']);
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
    expect(err.error.message).toContain('doesnotexist');
  });

  it('returns UNKNOWN_ARTIFACT when the branch has no captured artifacts', async () => {
    await agent.init({ noLlm: true });
    const err = await agent.expectError(['digest', '--json']);
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
    expect(err.error.message).toMatch(/main/);
  });

  it('returns UNINITIALIZED before init', async () => {
    const err = await agent.expectError(['digest', '--json']);
    expect(err.error.code).toBe('UNINITIALIZED');
  });

  it('--format json (no --out) emits the full data + markdown envelope to stdout', async () => {
    const artifactId = await seedThread();
    const result = await agent.runRaw(['digest', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      artifact_id: string;
      cached_at: string;
      data: { artifact_id: string; is_complete: boolean };
      markdown: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.artifact_id).toBe(artifactId);
    expect(parsed.cached_at).toMatch(/digest\.md$/);
    expect(parsed.data.is_complete).toBe(true);
    expect(parsed.markdown).toContain('# digest');
  });

  // DigestData is emitted verbatim in `digest --json`, so `outcome` is a public
  // contract surface, not just an internal builder field. A builder that drops
  // it makes an amended summary's dispositions invisible to anyone reading
  // only the digest.
  it('--json exposes the summary outcome, and null when the thread has no summary', async () => {
    const artifactId = await seedThread();
    const r = await agent.runRaw(['digest', '--artifact', artifactId, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      data: {
        outcome: string | null;
        checkpoints: Array<{ verification?: Array<{ command: string; exit_code: number }> }>;
      };
      markdown: string;
    };
    expect(out.data.outcome).toBe('shipped');
    expect(out.data.checkpoints[0].verification).toEqual([
      { command: 'test fixture', exit_code: 0 },
    ]);
    expect(out.markdown).not.toContain('test fixture');
    expect(out.markdown).toContain('## outcome  _(captured)_');
    expect(out.markdown).toContain('shipped');

    const wip = await agent.capturePlan(
      { task: 'no summary yet', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const rWip = await agent.runRaw(['digest', '--artifact', wip.artifact_id, '--json']);
    expect(rWip.exitCode).toBe(0);
    const outWip = JSON.parse(rWip.stdout) as {
      data: { outcome: string | null };
      markdown: string;
    };
    expect(outWip.data.outcome).toBeNull();
    expect(outWip.markdown).not.toContain('## outcome');
  }, 30_000);
});
