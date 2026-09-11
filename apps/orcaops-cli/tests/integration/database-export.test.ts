import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { tokens, usageObservation } from '../helpers/database-usage.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface TraceRecord {
  version: string;
  id: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: Array<{
    path: string;
    conversations: Array<{
      contributor: { type: string; model_id?: string; authors?: string[] };
      origin?: string;
      ranges: Array<{ start_line: number; end_line: number }>;
      match_kind: string;
      related: Array<{ type: string; url: string }>;
    }>;
  }>;
  metadata: {
    'ai.orcaops': {
      coverage: Record<string, number | boolean>;
      note: string;
    };
  };
}

function agentFor(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
}
async function exportTrace(f: Fixture, flags: string[] = []) {
  const raw = await agentFor(f).runRaw(['export', 'agent-trace', ...flags, '--json']);
  return {
    raw,
    body: JSON.parse(raw.stdout) as {
      commit?: string;
      record?: TraceRecord;
      out?: string;
      notes_written?: boolean;
      notes_ref?: string;
      error?: { code: string; message: string };
    },
  };
}

describe('registered database export agent-trace', { timeout: 90_000 }, () => {
  it('attributes a commit line by line from retained manifests without writing', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(
      f,
      'src/a.ts',
      'export const alpha = 1;\nexport const beta = 2;\n'
    );
    const close = await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
    });
    const before = await inventory(f.temporary);
    const { raw, body } = await exportTrace(f);
    expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
    expect(body.commit).toBe(head);
    const record = body.record!;
    expect(record).toMatchObject({
      version: '0.1.0',
      vcs: { type: 'git', revision: head },
      tool: { name: 'orcaops' },
    });
    expect(body.notes_written).toBe(false);
    expect(record.files.map((file) => file.path)).toEqual(['src/a.ts']);
    const conversation = record.files[0].conversations[0];
    expect(conversation).toMatchObject({
      contributor: { type: 'ai' },
      match_kind: 'line_content',
      ranges: [{ start_line: 1, end_line: 2 }],
      related: [{ type: 'session', url: `orcaops://artifact/${id}/checkpoint/${close.n}` }],
    });
    expect(conversation.contributor).not.toHaveProperty('model_id');
    expect(record.metadata['ai.orcaops'].coverage).toMatchObject({
      added_lines: 2,
      attributed_lines: 2,
      ambiguous_lines: 0,
      unattributed_lines: 0,
      manifestless_checkpoints: 0,
      incompatible_manifest_count: 0,
      diff_truncated: false,
      overlap_weak_lines: 0,
      overlap_provisional_lines: 0,
      cross_file_lines: 0,
    });
    expect(record.metadata['ai.orcaops'].note).toContain(
      'absence of attribution is not authorship evidence'
    );
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('emits human contributors with the recorded authors for imported history', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const imported = await f.capture(undefined, { reason: 'imported' });
    const head = await commitFile(f, 'src/legacy.ts', 'export const legacy = 1;\n');
    await closeFingerprintedCheckpoint(f, imported, {
      files: ['src/legacy.ts'],
      openRef: base,
      closeRef: head,
    });
    const before = await inventory(f.temporary);
    const { raw, body } = await exportTrace(f);
    expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
    const conversation = body.record!.files[0].conversations[0];
    expect(conversation).toMatchObject({
      contributor: { type: 'human', authors: ['Test'] },
      origin: 'git-import',
    });
    expect(conversation.contributor).not.toHaveProperty('model_id');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('names the token-dominant model, not the first listed, and skips incomplete snapshots', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/a.ts', 'export const alpha = 1;\n');
    const close = await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
    });
    // The first-listed model carries far fewer output tokens than the second, so a
    // reader that took the head of the list would name the wrong contributor.
    await usageObservation(f.writer, id, 1, {
      checkpoint_n: close.n,
      model_breakdown: [
        {
          model: 'claude-quiet',
          cumulative: { ...tokens(10), output_tokens: 5 },
          delta: null,
        },
        {
          model: 'claude-loud',
          cumulative: { ...tokens(10), output_tokens: 900 },
          delta: null,
        },
      ],
    });
    const before = await inventory(f.temporary);
    const { raw, body } = await exportTrace(f);
    expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
    expect(body.record!.files[0].conversations[0].contributor).toEqual({
      type: 'ai',
      model_id: 'anthropic/claude-loud',
    });
    expect(await inventory(f.temporary)).toEqual(before);

    // A snapshot whose retained record is incomplete cannot establish the model, so it
    // is skipped and the contributor falls back to no model_id rather than a guess.
    const raw2 = new Database(projectDatabasePath(f.authority));
    try {
      const trigger = raw2
        .prepare("SELECT sql FROM sqlite_schema WHERE name='usage_events_no_update'")
        .get() as { sql: string };
      raw2.exec('DROP TRIGGER usage_events_no_update');
      raw2
        .prepare('UPDATE usage_events SET completeness_json=?')
        .run(JSON.stringify({ state: 'incomplete', reasons: ['fixture'] }));
      raw2.exec(trigger.sql);
    } finally {
      raw2.close();
    }
    const skipped = await exportTrace(f);
    expect(skipped.raw.exitCode, skipped.raw.stderr || skipped.raw.stdout).toBe(0);
    expect(skipped.body.record!.files[0].conversations[0].contributor).toEqual({ type: 'ai' });
  });

  it('refuses when a pooled artifact no longer verifies instead of narrowing the pool', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const healthy = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    const damaged = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    const head = await commitFile(f, 'src/a.ts', 'export const alpha = 1;\n');
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
    const { raw: run, body } = await exportTrace(f);
    expect(run.exitCode).toBe(1);
    expect(body.error!.message).toContain(damaged);
    expect(body.error!.message).toMatch(/ambiguity pool/u);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('labels a cross-file-only content match with its own kind', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const claimed = await commitFile(
      f,
      'src/source.ts',
      'export const distinctive = "a value that repeats";\n'
    );
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/source.ts'],
      openRef: base,
      closeRef: claimed,
    });
    const copied = await commitFile(
      f,
      'src/copy.ts',
      'export const distinctive = "a value that repeats";\n'
    );
    const before = await inventory(f.temporary);
    const { raw, body } = await exportTrace(f, ['--commit', copied]);
    expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
    const record = body.record!;
    expect(record.files[0].path).toBe('src/copy.ts');
    expect(record.files[0].conversations[0].match_kind).toBe('line_content_cross_file');
    expect(record.metadata['ai.orcaops'].coverage.cross_file_lines).toBe(1);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('writes only the explicit --out target and the --notes ref', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture();
    const head = await commitFile(f, 'src/a.ts', 'export const alpha = 1;\n');
    await closeFingerprintedCheckpoint(f, id, {
      files: ['src/a.ts'],
      openRef: base,
      closeRef: head,
    });
    const target = path.join(f.temporary, 'trace.jsonl');
    const before = await inventory(f.root);
    const first = await agentFor(f).runRaw(['export', 'agent-trace', '--out', target, '--json']);
    expect(first.exitCode, first.stderr).toBe(0);
    const second = await agentFor(f).runRaw(['export', 'agent-trace', '--out', target, '--json']);
    expect(second.exitCode, second.stderr).toBe(0);
    const lines = (await readFile(target, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as TraceRecord).vcs.revision).toBe(head);
    expect(JSON.parse(second.stdout)).toMatchObject({ out: target, notes_written: false });
    // An in-repo target outside .agent-trace/ is called out on stderr.
    const inRepo = path.join(f.main, 'trace.jsonl');
    const warned = await agentFor(f).runRaw(['export', 'agent-trace', '--out', inRepo, '--json']);
    expect(warned.exitCode, warned.stderr).toBe(0);
    expect(warned.stderr).toContain('is inside the repo but outside .agent-trace/');
    // The registered history itself is untouched by any of it.
    expect(await inventory(f.root)).toEqual(before);

    const noted = await exportTrace(f, ['--notes']);
    expect(noted.raw.exitCode, noted.raw.stderr).toBe(0);
    expect(noted.body).toMatchObject({
      notes_written: true,
      notes_ref: 'refs/notes/orcaops/agent-trace',
    });
    const notes = await git(f.main, ['notes', '--ref', 'refs/notes/orcaops/agent-trace', 'list']);
    expect(notes.stdout.trim().split(' ')[1]).toBe(head);
    const refs = await git(f.main, ['for-each-ref', '--format=%(refname)', 'refs/notes']);
    expect(refs.stdout.trim().split('\n')).toEqual(['refs/notes/orcaops/agent-trace']);
    expect(await inventory(f.root)).toEqual(before);
  });
});
