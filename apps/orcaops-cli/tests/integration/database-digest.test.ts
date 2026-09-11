import Database from 'better-sqlite3';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { tokens, usageObservation } from '../helpers/database-usage.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

function agentFor(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
}
async function digest(f: Fixture, flags: string[]) {
  const raw = await agentFor(f).runRaw(['digest', ...flags, '--json']);
  return { raw, body: JSON.parse(raw.stdout) as Record<string, never> };
}
async function digestOk(f: Fixture, flags: string[]) {
  const { raw, body } = await digest(f, flags);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return body as unknown as {
    artifact_id: string;
    project_id: string;
    selection: { via: string };
    source_versions: { artifact: { generation: number } };
    data: Record<string, unknown>;
    usage: { accounting: { status: string }; estimates: Array<{ artifact_id: string }> };
    markdown: string;
    completeness: { complete: boolean; issues: unknown[] };
    note?: string;
    other_artifacts?: Array<{ id: string; state: string | null; unreadable?: true }>;
    other_artifact_count?: number;
  };
}
async function digestError(f: Fixture, flags: string[]) {
  const { raw, body } = await digest(f, flags);
  expect(raw.exitCode).toBe(1);
  return body as unknown as {
    error: {
      code: string;
      message: string;
      path?: string;
      history_candidates?: Array<{ id: string }>;
    };
  };
}
function dropTrigger<T>(f: Fixture, name: string, mutate: (raw: Database.Database) => T): T {
  const raw = new Database(projectDatabasePath(f.authority));
  try {
    const trigger = raw.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name) as {
      sql: string;
    };
    raw.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    const result = mutate(raw);
    raw.exec(trigger.sql);
    return result;
  } finally {
    raw.close();
  }
}

describe('registered database digest', { timeout: 90_000 }, () => {
  it('renders one artifact from its own event rows with evidence labels and canonical usage', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture(undefined, { reason: 'completed' });
    const other = await f.capture();
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
      summary: 'Ported the reader',
      verification: [{ command: 'test fixture', exit_code: 0 }],
    });
    // An unreadable sibling proves the exact read decodes only the selected artifact.
    dropTrigger(f, 'artifact_events_no_update', (raw) =>
      raw
        .prepare('UPDATE artifact_events SET record_bytes=? WHERE artifact_id=?')
        .run(Buffer.from('malformed'), other)
    );
    const before = await inventory(f.temporary);
    const result = await digestOk(f, [id]);
    expect(result).toMatchObject({
      artifact_id: id,
      project_id: f.authority.projectId,
      selection: { via: 'explicit' },
    });
    expect(result).not.toHaveProperty('cached_at');
    expect(result.data).toMatchObject({
      artifact_id: id,
      branch: 'main',
      is_complete: true,
      outcome: 'Completed fixture',
      files_changed: ['src/a.ts'],
    });
    expect(result.data.checkpoints).toEqual([
      expect.objectContaining({
        n: 1,
        summary: 'Ported the reader',
        verification: [{ command: 'test fixture', exit_code: 0 }],
      }),
    ]);
    expect(result.markdown).toContain(`# digest — \`main\` / \`${id}\``);
    expect(result.markdown).toContain('## outcome  _(captured)_');
    expect(result.markdown).toContain('`test fixture` — Agent reports command exited 0.');
    expect(result.markdown).toContain('Checkpoint subsequently closed at snapshot');
    expect(result.markdown).toContain('## agent usage');
    expect(result.usage.accounting.status).toBe('unavailable');
    expect(result.source_versions.artifact.generation).toBeGreaterThan(0);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('redacts secret-shaped text from both the data and the rendered markdown', async () => {
    const f = await fixture();
    const token = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(40)}`;
    const id = await f.capture(undefined, { task: `Rotate the deploy token ${token}` });
    const before = await inventory(f.temporary);
    const result = await digestOk(f, [id]);
    expect(JSON.stringify(result.data)).not.toContain(token);
    expect(result.markdown).not.toContain(token);
    expect(JSON.stringify(result.data)).toContain('[REDACTED_SECRET]');
    expect(result.markdown).toContain('[REDACTED_SECRET]');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('accepts a positional id, refuses a conflicting pair and refuses an absent artifact', async () => {
    const f = await fixture();
    const id = await f.capture();
    const before = await inventory(f.temporary);
    expect((await digestOk(f, [id])).artifact_id).toBe(id);
    expect((await digestOk(f, [id, '--artifact', id])).artifact_id).toBe(id);
    expect((await digestError(f, [id, '--artifact', '0'.repeat(8)])).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Conflicting artifact ids'),
    });
    expect((await digestError(f, ['--artifact', 'ffffffff'])).error.code).toBe('UNKNOWN_ARTIFACT');
    expect((await digestError(f, ['--artifact', id, '--branch', 'main'])).error.code).toBe(
      'SCOPE_CONFLICT'
    );
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('writes only the explicit --out target in markdown or JSON', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { reason: 'completed' });
    const before = await inventory(f.root);
    const markdownTarget = path.join(f.temporary, 'digest.md');
    const jsonTarget = path.join(f.temporary, 'digest.json');
    const md = await agentFor(f).runRaw(['digest', id, '--out', markdownTarget]);
    expect(md.exitCode, md.stderr).toBe(0);
    expect(md.stdout).toContain(`Wrote digest → ${markdownTarget}`);
    expect(await readFile(markdownTarget, 'utf8')).toContain(`# digest — \`main\` / \`${id}\``);
    const json = await agentFor(f).runRaw(['digest', id, '--out', jsonTarget, '--json']);
    expect(json.exitCode, json.stderr).toBe(0);
    const written = JSON.parse(await readFile(jsonTarget, 'utf8')) as {
      ok: boolean;
      data: { artifact_id: string };
    };
    expect(written).toMatchObject({ ok: true, data: { artifact_id: id } });
    expect(JSON.parse(json.stdout)).toMatchObject({ written_to: jsonTarget });
    expect(await inventory(f.root)).toEqual(before);
  });

  it('prefers the newest summarized artifact on the branch and discloses the siblings', async () => {
    const f = await fixture();
    const only = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    const before = await inventory(f.temporary);
    const inFlight = await digestOk(f, []);
    expect(inFlight).toMatchObject({ artifact_id: only, selection: { via: 'branch' } });
    expect(inFlight.note).toContain('in-flight');
    expect(inFlight).not.toHaveProperty('other_artifacts');
    const human = await agentFor(f).runRaw(['digest']);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stderr).toContain('in-flight');
    expect(human.stdout).not.toContain('in-flight (no summary');
    expect(await inventory(f.temporary)).toEqual(before);

    // A newer in-flight sibling must not outrank a summarized thread, and a default
    // selection never refuses just because the branch carries more than one artifact.
    const summarized = await f.capture(undefined, {
      ts: '2026-09-02T00:00:00.000Z',
      reason: 'completed',
    });
    const newest = await f.capture(undefined, { ts: '2026-09-03T00:00:00.000Z' });
    const withBoth = await inventory(f.temporary);
    const chosen = await digestOk(f, []);
    expect(chosen).toMatchObject({ artifact_id: summarized, selection: { via: 'branch' } });
    expect(chosen).not.toHaveProperty('note');
    expect(chosen.other_artifact_count).toBe(2);
    expect(chosen.other_artifacts?.map((row) => row.id).sort()).toEqual([newest, only].sort());
    expect(chosen.other_artifacts?.[0]).toMatchObject({ state: 'planned', origin: null });
    expect(chosen.other_artifacts?.[0]).not.toHaveProperty('unreadable');
    expect(chosen).not.toHaveProperty('other_artifacts_truncated', true);
    const siblingHuman = await agentFor(f).runRaw(['digest']);
    expect(siblingHuman.stderr).toContain('2 other artifact(s) on this branch not digested');
    expect(siblingHuman.stderr).toContain('pass --artifact <id> to digest one of them');
    // An explicit selection discloses nothing about the others, note included.
    const explicit = await digestOk(f, ['--artifact', newest]);
    expect(explicit).toMatchObject({ artifact_id: newest, selection: { via: 'explicit' } });
    expect(explicit).not.toHaveProperty('note');
    expect(explicit).not.toHaveProperty('other_artifacts');
    expect((await digestError(f, ['--branch', 'linked'])).error).toMatchObject({
      code: 'UNKNOWN_ARTIFACT',
      message: expect.stringContaining('linked'),
      path: 'branch',
    });
    expect(await inventory(f.temporary)).toEqual(withBoth);
  });

  it('reports an unreadable sibling as unknown rather than substituting a state', async () => {
    const f = await fixture();
    const chosen = await f.capture(undefined, {
      ts: '2026-09-02T00:00:00.000Z',
      reason: 'completed',
    });
    const rotted = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    dropTrigger(f, 'artifact_revisions_no_update', (raw) =>
      raw
        .prepare('UPDATE artifact_revisions SET ordered_hash=? WHERE artifact_id=?')
        .run('0'.repeat(64), rotted)
    );
    const before = await inventory(f.temporary);
    const result = await digestOk(f, []);
    expect(result.artifact_id).toBe(chosen);
    expect(result.other_artifacts).toEqual([
      { id: rotted, state: null, unreadable: true, label: `History ${rotted}`, origin: null },
    ]);
    const human = await agentFor(f).runRaw(['digest']);
    expect(human.stderr).toContain(`${rotted.slice(0, 8)} (unreadable)`);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('refuses missing registered history instead of reporting a fresh install', async () => {
    const f = await fixture();
    const id = await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const missing = await digestError(f, [id]);
    expect(missing.error.code).toBe('HISTORY_MISSING');
    expect(missing.error.message).not.toMatch(/init|fresh/iu);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('combines branch-wide members from committed anchors and discloses what it left out', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const earlier = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    await f.recordFiles(earlier, ['src/earlier.ts'], base);
    const rangeBase = await commitFile(f, 'src/base.ts', 'export const base = 0;\n');
    const primary = await f.capture(undefined, {
      ts: '2026-09-02T00:00:00.000Z',
      reason: 'completed',
    });
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    await closeFingerprintedCheckpoint(f, primary, {
      files: ['src/a.ts'],
      openRef: rangeBase,
      closeRef: head,
      summary: 'Landed the primary change',
    });
    const followUp = await f.capture(undefined, { ts: '2026-09-03T00:00:00.000Z' });
    const head2 = await commitFile(f, 'src/b.ts', 'export const b = 2;\n');
    await f.recordFiles(followUp, ['src/b.ts'], head2);
    await usageObservation(f.writer, earlier, 300, { session_id: 'excluded-session' });
    await usageObservation(f.writer, primary, 10);
    await usageObservation(f.writer, followUp, 20);
    const before = await inventory(f.temporary);
    const result = await digestOk(f, ['--branch-wide', '--base', rangeBase]);
    const data = result.data as unknown as {
      mode: string;
      artifacts: Array<{ id: string; role: string; state: string; matched_anchors: unknown[] }>;
      excluded_artifacts: Array<{ id: string; reason: string }>;
      unreadable_artifacts: unknown[];
      title: { source_artifact_id: string };
    };
    expect(data.mode).toBe('branch-wide');
    expect(data.artifacts.map((artifact) => artifact.id)).toEqual([primary, followUp]);
    expect(data.artifacts[0]).toMatchObject({ role: 'primary', state: 'summarized' });
    expect(data.artifacts[1]).toMatchObject({ role: 'follow-up', state: 'active' });
    expect(data.artifacts[0].matched_anchors).toEqual([
      expect.objectContaining({ source: 'checkpoint', n: 1 }),
    ]);
    expect(data.title.source_artifact_id).toBe(primary);
    expect(data.excluded_artifacts).toEqual([{ id: earlier, reason: 'reachable_out_of_range' }]);
    expect(data.unreadable_artifacts).toEqual([]);
    expect(result.markdown).toContain('## included artifacts');
    expect(result.markdown).toContain('Landed the primary change');
    expect(result.markdown).toContain('## agent usage');
    expect(result.usage.accounting).toMatchObject({ status: 'exact', totals: tokens(20) });
    expect(result.usage.estimates.map((estimate) => estimate.artifact_id).sort()).toEqual(
      [primary, followUp].sort()
    );
    expect(result.markdown).toContain('Exact selected session totals: in 20');
    expect(
      (await digestError(f, ['--branch-wide', '--base', rangeBase, '--primary-artifact', earlier]))
        .error.code
    ).toBe('INVALID_INPUT');
    expect((await digestError(f, ['--branch-wide', '--artifact', primary])).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('--branch-wide'),
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports unreadable branch-wide metadata as an integrity issue, never an empty range', async () => {
    const f = await fixture();
    const rangeBase = f.context.headOid!;
    const first = await f.capture(undefined, {
      ts: '2026-09-01T00:00:00.000Z',
      reason: 'completed',
    });
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    await f.recordFiles(first, ['src/a.ts'], head);
    const second = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    await f.recordFiles(second, ['src/b.ts'], head);
    const damaged = await f.capture(undefined, { ts: '2026-09-03T00:00:00.000Z' });
    await f.recordFiles(damaged, ['src/c.ts'], head);
    const raw = new Database(projectDatabasePath(f.authority));
    try {
      raw
        .prepare(
          "UPDATE artifact_query_metadata SET details_json=json_set(details_json,'$.anchors',NULL) WHERE artifact_id=?"
        )
        .run(damaged);
    } finally {
      raw.close();
    }
    const before = await inventory(f.temporary);
    const result = await digestOk(f, ['--branch-wide', '--base', rangeBase]);
    const data = result.data as unknown as {
      artifacts: Array<{ id: string }>;
      unreadable_artifacts: Array<{ id: string; reason: string }>;
    };
    // The healthy members still render, and the damaged row is disclosed rather than
    // collapsing the whole range into "no recorded work".
    expect(data.artifacts.map((artifact) => artifact.id).sort()).toEqual([first, second].sort());
    expect(data.unreadable_artifacts).toEqual([{ id: damaged, reason: 'unverifiable' }]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })],
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('discloses a branch-wide member whose retained history no longer verifies', async () => {
    const f = await fixture();
    const rangeBase = f.context.headOid!;
    const healthy = await f.capture(undefined, {
      ts: '2026-09-01T00:00:00.000Z',
      reason: 'completed',
    });
    const head = await commitFile(f, 'src/a.ts', 'export const a = 1;\n');
    await f.recordFiles(healthy, ['src/a.ts'], head);
    const damaged = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    await f.recordFiles(damaged, ['src/b.ts'], head);
    dropTrigger(f, 'artifact_revisions_no_update', (raw) =>
      raw
        .prepare('UPDATE artifact_revisions SET ordered_hash=? WHERE artifact_id=?')
        .run('0'.repeat(64), damaged)
    );
    const before = await inventory(f.temporary);
    const result = await digestOk(f, ['--branch-wide', '--base', rangeBase]);
    const data = result.data as unknown as {
      artifacts: Array<{ id: string }>;
      unreadable_artifacts: Array<{ id: string; reason: string }>;
    };
    expect(data.artifacts.map((artifact) => artifact.id)).toEqual([healthy]);
    expect(data.unreadable_artifacts).toEqual([{ id: damaged, reason: 'unverifiable' }]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })],
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
