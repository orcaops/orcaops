import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface Attribution {
  base: { ref: string; sha: string; source: string };
  manifest_scope: { kind: string; artifact_id?: string; branch?: string };
  target: { kind: string; ref?: string; sha?: string; tree_sha?: string };
  attribution_granularity: 'hunk' | 'file' | 'none';
  hunks?: Array<{ file: string | null; matches: Array<{ artifact_id: string }> }>;
  file_attributions?: Array<{ artifact_id: string; checkpoint_n: number; files: string[] }>;
  unattributed: Array<{ file: string | null }> | null;
  coverage: { attributed_hunks: number; attributed_pct: number | null } | null;
  checkpoint_granularity: Record<string, string>;
  disclosure: { manifestless_checkpoints: unknown[]; incompatible_manifest_count: number };
}
interface Reconcile {
  artifact: { id: string; source: string };
  base: { sha: string };
  window: {
    head: { sha: string; source: string; checkpoint_n: number | null };
    total_commits: number;
    covered_commit_count: number;
    uncovered_commits: Array<{ sha: string; subject: string }>;
  };
  pre_summary?: { summary_head_sha: string; uncovered_commits: Array<{ sha: string }> };
  post_window_commits: Array<{ sha: string; subject: string }>;
  disclosure: {
    coverage_basis: string;
    no_closed_checkpoints: boolean;
    skipped_unreadable_artifacts: string[];
    manifestless_checkpoints: unknown[];
  };
}

function agentFor(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
}
async function diff<T>(f: Fixture, flags: string[]) {
  const raw = await agentFor(f).runRaw(['diff', ...flags, '--json']);
  return { raw, body: JSON.parse(raw.stdout) as T & { error?: { code: string; message: string } } };
}
async function diffOk<T>(f: Fixture, flags: string[]) {
  const { raw, body } = await diff<T>(f, flags);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return body;
}
async function diffError(f: Fixture, flags: string[]) {
  const { raw, body } = await diff<Record<string, never>>(f, flags);
  expect(raw.exitCode).toBe(1);
  return body.error!;
}

describe('registered database diff', { timeout: 90_000 }, () => {
  it('attributes hunks against retained manifests and stays passive under --target', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
      summary: 'Added the constants',
    });
    const before = await inventory(f.temporary);
    const committed = await diffOk<Attribution>(f, ['--attribution', '--target', head]);
    expect(committed).toMatchObject({
      base: { ref: `artifact:${id}`, sha: base, source: 'active_artifact' },
      manifest_scope: { kind: 'branch', branch: 'main' },
      target: { kind: 'ref', ref: head, sha: head },
      attribution_granularity: 'hunk',
    });
    expect(committed.hunks?.[0].matches).toEqual([
      expect.objectContaining({ artifact_id: id, checkpoint_n: 1 }),
    ]);
    expect(committed.unattributed).toEqual([]);
    expect(committed.coverage).toMatchObject({ attributed_hunks: 1, attributed_pct: 100 });
    expect(committed.checkpoint_granularity).toEqual({ [`${id}:1`]: 'hunk' });
    // A committed target is a fully passive read.
    expect(await inventory(f.temporary)).toEqual(before);

    await writeFile(
      path.join(f.main, 'src/a.ts'),
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n'
    );
    const live = await diffOk<Attribution>(f, ['--attribution']);
    expect(live.target.kind).toBe('worktree');
    expect(live.unattributed).toHaveLength(1);
    const unattributedOnly = await diffOk<Attribution>(f, ['--attribution', '--unattributed']);
    expect(unattributedOnly.hunks).toBeUndefined();
    expect(unattributedOnly.file_attributions).toBeUndefined();
    expect(unattributedOnly.unattributed).toHaveLength(1);
  });

  it('bounds the live attribution capture to unreachable tree objects and no ref', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
    });
    await writeFile(path.join(f.main, 'src/a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const snapshot = async () => ({
      refs: (await git(f.main, ['for-each-ref', '--format=%(refname)'])).stdout,
      status: (await git(f.main, ['status', '--porcelain'])).stdout,
      staged: (await git(f.main, ['diff-index', '--cached', '--name-only', 'HEAD'])).stdout,
      loose: Number(/count: (\d+)/u.exec((await git(f.main, ['count-objects', '-v'])).stdout)![1]),
    });
    const before = await snapshot();
    expect((await diffOk<Attribution>(f, ['--attribution'])).target.kind).toBe('worktree');
    const after = await snapshot();
    // The capture writes only the tree objects it diffs against: no ref moves, the real
    // index is untouched, and every new object is unreachable (collectable by gc).
    expect(after.refs).toBe(before.refs);
    expect(after.status).toBe(before.status);
    expect(after.staged).toBe(before.staged);
    expect(after.loose - before.loose).toBe(3);
    const unreachable = (await git(f.main, ['fsck', '--unreachable', '--no-progress'])).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(unreachable).toHaveLength(3);
    for (const line of unreachable) expect(line).toMatch(/^unreachable (tree|blob) [0-9a-f]{40}$/u);
  });

  it('resolves the base from --base, then --artifact, and refuses without either', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const older = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    await f.recordFiles(older, ['src/a.ts'], head);
    const newer = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    const before = await inventory(f.temporary);
    expect((await diffOk<Attribution>(f, ['--attribution', '--target', head])).base).toMatchObject({
      source: 'active_artifact',
    });
    expect(
      (await diffOk<Attribution>(f, ['--attribution', '--target', head, '--artifact', older])).base
    ).toMatchObject({ ref: `artifact:${older}`, source: 'artifact_flag' });
    const explicit = await diffOk<Attribution>(f, [
      '--attribution',
      '--target',
      head,
      '--base',
      base,
      '--artifact',
      older,
    ]);
    expect(explicit.base).toMatchObject({ ref: base, sha: base, source: 'flag' });
    expect(explicit.manifest_scope).toMatchObject({ kind: 'artifact', artifact_id: older });
    expect(newer).not.toBe(older);
    expect((await diffError(f, ['--attribution', '--artifact', 'ffffffff'])).code).toBe(
      'UNKNOWN_ARTIFACT'
    );
    expect((await diffError(f, ['--attribution', '--reconcile'])).code).toBe('INVALID_INPUT');
    expect((await diffError(f, ['--reconcile', '--unattributed'])).code).toBe('INVALID_INPUT');
    expect((await diffError(f, [])).message).toContain('Plain `orcaops diff` is reserved');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('degrades to file-level attribution for a checkpoint that recorded no manifest', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/plain.ts', 'export const plain = 1;\n');
    await f.recordFiles(id, ['src/plain.ts'], head);
    const before = await inventory(f.temporary);
    const result = await diffOk<Attribution>(f, [
      '--attribution',
      '--base',
      base,
      '--target',
      head,
    ]);
    expect(result.attribution_granularity).toBe('file');
    expect(result.file_attributions).toEqual([
      { artifact_id: id, checkpoint_n: 1, files: ['src/plain.ts'] },
    ]);
    expect(result.checkpoint_granularity).toEqual({ [`${id}:1`]: 'file' });
    expect(result.disclosure.manifestless_checkpoints).toEqual([
      { artifact_id: id, checkpoint_n: 1 },
    ]);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('refuses attribution when a branch artifact no longer verifies', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const damaged = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    const healthy = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    await f.recordFiles(damaged, ['src/other.ts'], head);
    await closeFingerprintedCheckpoint(f, healthy, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
    });
    const raw = new Database(projectDatabasePath(f.authority));
    try {
      const trigger = raw
        .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_revisions_no_update'")
        .get() as { sql: string };
      raw.exec('DROP TRIGGER artifact_revisions_no_update');
      raw
        .prepare('UPDATE artifact_revisions SET ordered_hash=? WHERE artifact_id=?')
        .run('0'.repeat(64), damaged);
      raw.exec(trigger.sql);
    } finally {
      raw.close();
    }
    const before = await inventory(f.temporary);
    // A shrunken ambiguity pool would attribute a contested hunk confidently.
    const refused = await diffError(f, ['--attribution', '--target', head]);
    expect(refused.message).toContain(damaged);
    expect(refused.message).toMatch(/ambiguity pool/u);
    // Scoped to the healthy artifact the pool is complete again.
    const scoped = await diffOk<Attribution>(f, [
      '--attribution',
      '--target',
      head,
      '--artifact',
      healthy,
    ]);
    expect(scoped.attribution_granularity).toBe('hunk');
    // Reconcile only weakens coverage, so it discloses the omission and continues.
    const reconciled = await diffOk<Reconcile>(f, ['--reconcile']);
    expect(reconciled.artifact.id).toBe(healthy);
    expect(reconciled.disclosure.skipped_unreadable_artifacts).toEqual([damaged]);
    // The omission is visible in human mode too, not only in the JSON disclosure.
    const human = await agentFor(f).runRaw(['diff', '--reconcile']);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stderr).toContain(`skipping unreadable artifact ${damaged}`);
    // Scoping to one artifact takes the unreadable sibling out of the read set.
    const scopedReconcile = await diffOk<Reconcile>(f, ['--reconcile', '--artifact', healthy]);
    expect(scopedReconcile.disclosure.skipped_unreadable_artifacts).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reconciles the artifact window and reports a commit no checkpoint accounts for', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const covered = await commitFile(f, 'src/covered.ts', 'export const covered = 1;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/covered.ts'],
      openRef: base,
      closeRef: covered,
      summary: 'Covered only one file',
    });
    const planted = await commitFile(f, 'src/planted.ts', 'export const planted = 1;\n', 'planted');
    // A second close moves the window head past the planted commit without claiming it.
    await f.recordFiles(id, [], planted);
    const trailing = await commitFile(f, 'src/after.ts', 'export const after = 1;\n', 'after');
    const before = await inventory(f.temporary);
    const result = await diffOk<Reconcile>(f, ['--reconcile']);
    expect(result.artifact).toMatchObject({ id, source: 'active_artifact' });
    expect(result.base.sha).toBe(base);
    expect(result.window.head).toMatchObject({
      sha: planted,
      source: 'latest_closed_checkpoint',
      checkpoint_n: 2,
    });
    expect(result.window.total_commits).toBe(2);
    expect(result.window.covered_commit_count).toBe(1);
    expect(result.window.uncovered_commits.map((commit) => commit.sha)).toEqual([planted]);
    expect(result.post_window_commits.map((commit) => commit.sha)).toEqual([trailing]);
    expect(result.disclosure).toMatchObject({
      coverage_basis: 'files_changed_and_manifests',
      no_closed_checkpoints: false,
    });
    expect(covered).not.toBe(planted);
    const human = await agentFor(f).runRaw(['diff', '--reconcile']);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain('Reconcile — artifact');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('falls back to branch HEAD without a closed checkpoint and refuses an unresolvable base', async () => {
    const f = await fixture();
    const id = await f.capture();
    const head = await commitFile(f, 'src/only.ts', 'export const only = 1;\n');
    const before = await inventory(f.temporary);
    const fallback = await diffOk<Reconcile>(f, ['--reconcile', '--artifact', id]);
    expect(fallback.window.head).toMatchObject({
      sha: head,
      source: 'branch_head_fallback',
      checkpoint_n: null,
    });
    expect(fallback.disclosure).toMatchObject({
      no_closed_checkpoints: true,
      coverage_basis: 'files_changed_only',
    });
    expect(await inventory(f.temporary)).toEqual(before);

    const g = await fixture();
    const pruned = await g.capture();
    // A recorded head that Git can no longer resolve must error, never read clean.
    await g.recordFiles(pruned, ['src/gone.ts'], '0'.repeat(40));
    const refused = await diffError(g, ['--reconcile', '--artifact', pruned]);
    expect(refused.code).toBe('INVALID_INPUT');
    expect(refused.message).toMatch(/does not resolve to a commit/u);
    expect(refused.message).toContain('refusing to reconcile');
  });

  it('splits a summarized artifact window at its summary commit', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const closeAt = await commitFile(f, 'src/window.ts', 'export const window = 1;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/window.ts'],
      openRef: base,
      closeRef: closeAt,
      summary: 'Closed the window',
    });
    const preSummary = await commitFile(f, 'src/late.ts', 'export const late = 1;\n', 'late work');
    await f.mutate(id, { outcome: 'Summarized after late work' }, (semantics) =>
      semantics.writeSummary({
        schema_version: 1,
        artifact_id: id,
        outcome: 'Summarized after late work',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: preSummary,
        ts: '2026-09-06T00:00:00.000Z',
      })
    );
    const afterSummary = await commitFile(f, 'src/post.ts', 'export const post = 1;\n', 'post');
    const before = await inventory(f.temporary);
    const result = await diffOk<Reconcile>(f, ['--reconcile', '--artifact', id]);
    expect(result.pre_summary).toMatchObject({ summary_head_sha: preSummary });
    expect(result.pre_summary?.uncovered_commits.map((commit) => commit.sha)).toEqual([preSummary]);
    expect(result.post_window_commits.map((commit) => commit.sha)).toEqual([afterSummary]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
