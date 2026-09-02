import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops snapshots prune`.
 *
 * Covers per-flag behavior, dry-run non-destructiveness, the raw-set
 * `--orphans` (absent-artifact AND planted-malformed), the
 * `--all`-requires-`--apply` guard, selector validation, and the
 * mandatory non-re-derivability warning in both modes.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function gitRefs(repoPath: string): string[] {
  return execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/orcaops/snap/'], {
    cwd: repoPath,
  })
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort();
}

describe('orcaops snapshots prune', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    // Drain disabled so capture runs with no cloud I/O; snapshot capture is on by
    // default (auth-independent).
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  // Plan → open → commit → close: pins refs/orcaops/snap/<id>/1/{open,close}.
  async function capturedArtifact(file: string): Promise<string> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'snapshots prune fixture',
          label: `snap-${file}`,
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await commitFile(repo.path, file, 'export const x = 1;\n', 'work');
    await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1',
          files_changed: [],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    return plan.artifact_id;
  }

  async function writeLooseRef(segs: string[]): Promise<void> {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path }).toString().trim();
    const dir = path.join(repo.path, '.git', 'refs', 'orcaops', 'snap', ...segs.slice(0, -1));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(repo.path, '.git', 'refs', 'orcaops', 'snap', ...segs),
      head + '\n',
      'utf8'
    );
  }

  function prune(args: string[]): Promise<CliResult> {
    return agent.runRaw(['snapshots', 'prune', ...args]);
  }

  async function summarize(artifactId: string): Promise<void> {
    await agent.runRaw([
      'capture',
      'pre-pr-check',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({ idempotency_key: `prepr-${randomUUID()}`, artifact_id: artifactId })
      ),
    ]);
    // `capture summary` has no `--no-llm` option (only pre-pr-check does).
    await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'done',
        })
      ),
    ]);
  }

  it('--artifact dry-run is non-destructive', async () => {
    const id = await capturedArtifact('a.ts');
    const before = gitRefs(repo.path);
    expect(before.length).toBeGreaterThan(0);

    const r = await prune(['--artifact', id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      ok: boolean;
      applied: boolean;
      deleted: number;
      candidates: string[];
      warning: string;
    };
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.deleted).toBe(0);
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.warning).toMatch(/non-re-derivable/);
    expect(gitRefs(repo.path)).toEqual(before); // untouched
  });

  it('--artifact --apply deletes only that artifact, leaving others', async () => {
    const a = await capturedArtifact('a.ts');
    const b = await capturedArtifact('b.ts');
    const bRefs = gitRefs(repo.path).filter((r) => r.includes(`/${b}/`));
    expect(bRefs.length).toBeGreaterThan(0);

    const r = await prune(['--artifact', a, '--apply', '--json']);
    const out = JSON.parse(r.stdout) as { deleted: number; candidates: string[] };
    expect(r.exitCode).toBe(0);
    expect(out.deleted).toBe(out.candidates.length);
    expect(out.deleted).toBeGreaterThan(0);
    const after = gitRefs(repo.path);
    expect(after.some((x) => x.includes(`/${a}/`))).toBe(false); // a gone
    expect(after.filter((x) => x.includes(`/${b}/`))).toEqual(bRefs); // b intact
  });

  it('--artifact --apply refuses when the checkpoint read refuses (never deletes on rot)', async () => {
    // The underived probe only runs with the archive enabled — which is
    // exactly the configuration where pruning deletes the last
    // derivation source.
    const enable = await agent.runRaw(['archive', 'enable', '--json']);
    expect(enable.exitCode).toBe(0);
    const id = await capturedArtifact('a.ts');
    const before = gitRefs(repo.path);
    expect(before.length).toBeGreaterThan(0);

    // Rot a non-tail line: the underived probe's checkpoint read now
    // refuses, and a refusal must never be converted into "nothing to
    // protect" — the prune aborts with every ref intact.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', id);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');

    const r = await prune(['--artifact', id, '--apply', '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(gitRefs(repo.path)).toEqual(before); // nothing deleted
  });

  it('--orphans --apply removes absent-artifact AND malformed refs, keeps live', async () => {
    const live = await capturedArtifact('a.ts');
    const liveRefs = gitRefs(repo.path);
    // Parseable ref for an artifact_id absent from the store.
    await writeLooseRef(['019e0000-0000-7000-8000-000000000000', '1', 'open']);
    // Malformed-but-valid-git ref directly under the namespace.
    await writeLooseRef(['malformed-stray']);

    const r = await prune(['--orphans', '--apply', '--json']);
    const out = JSON.parse(r.stdout) as { deleted: number; candidates: string[] };
    expect(r.exitCode).toBe(0);
    expect(out.candidates).toContain(
      'refs/orcaops/snap/019e0000-0000-7000-8000-000000000000/1/open'
    );
    expect(out.candidates).toContain('refs/orcaops/snap/malformed-stray');
    expect(out.deleted).toBe(2);
    // The live artifact's refs survive.
    const after = gitRefs(repo.path);
    for (const r0 of liveRefs.filter((x) => x.includes(`/${live}/`))) {
      expect(after).toContain(r0);
    }
  });

  it('--all without --apply is rejected', async () => {
    await capturedArtifact('a.ts');
    const r = await prune(['--all', '--json']);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('INVALID_INPUT');
  });

  it('--all --apply removes every snapshot ref', async () => {
    await capturedArtifact('a.ts');
    await capturedArtifact('b.ts');
    expect(gitRefs(repo.path).length).toBeGreaterThan(0);
    const r = await prune(['--all', '--apply', '--json']);
    expect(r.exitCode).toBe(0);
    expect(gitRefs(repo.path)).toEqual([]);
  });

  it('rejects zero and multiple selectors', async () => {
    const none = await prune(['--json']);
    expect(none.exitCode).toBe(1);
    expect((JSON.parse(none.stdout) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT'
    );
    const two = await prune(['--orphans', '--all', '--apply', '--json']);
    expect(two.exitCode).toBe(1);
    expect((JSON.parse(two.stdout) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT'
    );
  });

  it('warns in human + JSON, in both dry-run and apply modes', async () => {
    const id = await capturedArtifact('a.ts');
    const dryHuman = await prune(['--artifact', id]);
    expect(dryHuman.stdout).toMatch(/non-re-derivable/);
    const applyHuman = await prune(['--artifact', id, '--apply']);
    expect(applyHuman.stdout).toMatch(/non-re-derivable/);
    const id2 = await capturedArtifact('b.ts');
    const dryJson = JSON.parse((await prune(['--artifact', id2, '--json'])).stdout) as {
      warning: string;
    };
    expect(dryJson.warning).toMatch(/non-re-derivable/);
    const applyJson = JSON.parse(
      (await prune(['--artifact', id2, '--apply', '--json'])).stdout
    ) as { warning: string };
    expect(applyJson.warning).toMatch(/non-re-derivable/);
  });

  it('unknown artifact id with no refs → deleted:0, exit 0', async () => {
    const r = await prune(['--artifact', 'nonexistent-artifact', '--apply', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { deleted: number; candidates: string[] };
    expect(out.deleted).toBe(0);
    expect(out.candidates).toEqual([]);
  });

  it('output carries no raw diff / forbidden keys', async () => {
    const id = await capturedArtifact('a.ts');
    const r = await prune(['--artifact', id, '--json']);
    const FORBIDDEN = new Set([
      'diff',
      'patch',
      'diff_text',
      'patch_text',
      'raw_diff',
      'raw_patch',
    ]);
    function visit(node: unknown): void {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const c of node) visit(c);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        expect(FORBIDDEN.has(k), `forbidden key ${k}`).toBe(false);
        visit(v);
      }
    }
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    visit(env);
    const s = JSON.stringify(env);
    expect(s).not.toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(s).not.toContain('--- a/');
    expect(s).not.toContain('+++ b/');
  });

  it('--orphans --apply reclaims an unmodeled pin-before-append ref, keeps modeled refs', async () => {
    const a = await capturedArtifact('a.ts'); // modeled cp1 → .../a/1/{open,close}
    await summarize(a);
    // Pin-before-append crash orphan: parseable, artifact exists + has
    // a summary, but checkpoint n=2 never committed.
    await writeLooseRef([a, '2', 'open']);

    const r = await prune(['--orphans', '--apply', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { deleted: number; candidates: string[] };
    expect(out.candidates).toContain(`refs/orcaops/snap/${a}/2/open`);
    expect(out.candidates).not.toContain(`refs/orcaops/snap/${a}/1/open`);
    expect(out.candidates).not.toContain(`refs/orcaops/snap/${a}/1/close`);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    const after = gitRefs(repo.path);
    expect(after).not.toContain(`refs/orcaops/snap/${a}/2/open`); // reclaimed
    expect(after).toContain(`refs/orcaops/snap/${a}/1/open`); // modeled — kept
    expect(after).toContain(`refs/orcaops/snap/${a}/1/close`);
  });

  it('--orphans leaves an unmodeled ref on an IN-FLIGHT (no-summary) artifact (mirrors doctor gate)', async () => {
    const b = await capturedArtifact('b.ts'); // closed cp1 but NOT summarized
    await writeLooseRef([b, '2', 'open']);
    const r = await prune(['--orphans', '--apply', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { candidates: string[] };
    // No drift with doctor: doctor only flags unmodeled on SUMMARIZED
    // artifacts, so --orphans must not reclaim an in-flight one either.
    expect(out.candidates).not.toContain(`refs/orcaops/snap/${b}/2/open`);
    expect(gitRefs(repo.path)).toContain(`refs/orcaops/snap/${b}/2/open`);
  });
});
