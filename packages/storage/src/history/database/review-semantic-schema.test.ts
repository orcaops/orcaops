import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((database) => database.close()));
const retained = JSON.parse(
  readFileSync(new URL('./fixtures/review-inputs.json', import.meta.url), 'utf8')
) as { rows: Record<string, Record<string, string | number | null | { blobHex: string }>[]> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function receipt(db: Database.Database, payload = { rawSubmissionSha256: hash('{}') }) {
  const operationId = uuidv7();
  db.prepare(
    "INSERT INTO operations VALUES (?, 'review.semantic.fixture', 0, '{}', ?, ?, '{}', '{}', 1, 0)"
  ).run(operationId, JSON.stringify(payload), hash(JSON.stringify(payload)));
  return operationId;
}
function fixture() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  db.pragma('foreign_keys = ON');
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
    .all() as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec('BEGIN IMMEDIATE');
  db.pragma('defer_foreign_keys = ON');
  for (const [table, rows] of Object.entries(retained.rows))
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      ).run(
        ...Object.values(row).map((value) =>
          value && typeof value === 'object' ? Buffer.from(value.blobHex, 'hex') : value
        )
      );
    }
  db.exec('COMMIT');
  for (const trigger of triggers) db.exec(trigger.sql);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  const before = db.pragma('user_version', { simple: true });
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='review_semantic_generations'").get()
  ).toEqual({ name: 'review_semantic_generations' });
  expect(db.pragma('user_version', { simple: true })).toBe(before);
  expect(before).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
  const runs = db.prepare('SELECT * FROM review_runs ORDER BY run_id').all() as {
    run_id: string;
    review_id: string;
    current_revision_id: string;
    version: number;
  }[];
  const sources = runs.map((run) => {
    const revision = db
      .prepare('SELECT * FROM review_run_revisions WHERE revision_id = ?')
      .get(run.current_revision_id) as {
      membership_revision_id: string;
      floor_publication_id: string;
      record_bytes: Buffer;
    };
    const operation = receipt(db);
    db.prepare('INSERT INTO review_run_finalizations VALUES (?, ?, ?, ?, ?, ?)').run(
      run.run_id,
      run.review_id,
      run.current_revision_id,
      operation,
      Buffer.from('{}'),
      hash('{}')
    );
    const publication = uuidv7();
    db.prepare(
      "INSERT INTO review_evidence_publications VALUES (?, ?, 'semantic', ?, ?, ?, 'fixture-floor', ?, ?, NULL, '{}')"
    ).run(
      publication,
      run.review_id,
      operation,
      revision.membership_revision_id,
      revision.floor_publication_id,
      run.run_id,
      run.current_revision_id
    );
    return { ...run, publication };
  });
  return { db, sources };
}
type Source = ReturnType<typeof fixture>['sources'][number];
function generation(db: Database.Database, source: Source, override: Partial<Source> = {}) {
  const selected = { ...source, ...override };
  const generationId = uuidv7(),
    operationId = receipt(db);
  db.prepare('INSERT INTO review_semantic_generations VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    generationId,
    selected.review_id,
    selected.run_id,
    selected.current_revision_id,
    selected.publication,
    'semantic',
    operationId
  );
  return { generationId, source: selected, operationId };
}
type Generation = ReturnType<typeof generation>;
function attempt(
  db: Database.Database,
  g: Generation,
  accepted = true,
  number = 1,
  override: Record<string, unknown> = {}
) {
  const revisionId = uuidv7(),
    operationId = number === 1 ? g.operationId : receipt(db);
  const outcome = accepted
    ? number === 1
      ? 'ACCEPTED_CLEAN_FIRST_PASS'
      : 'ACCEPTED_REPAIRED'
    : number === 1
      ? 'REJECTED_FIRST_PASS'
      : 'TERMINAL_REJECTED';
  const record = {
    schema_version: 3,
    generation_id: g.generationId,
    run_id: g.source.run_id,
    attempt: number,
    accepted,
    outcome,
    ...override,
  };
  const bytes = '  ' + JSON.stringify(record) + '\n';
  db.prepare(
    'INSERT INTO review_semantic_attempts (revision_id,generation_id,attempt_number,record_json,record_sha256,operation_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(revisionId, g.generationId, number, bytes, hash(bytes), operationId);
  return { revisionId, record, bytes, operationId };
}
function terminal(
  db: Database.Database,
  g: Generation,
  a: ReturnType<typeof attempt>,
  override: Record<string, unknown> = {}
) {
  const publicationId = a.record.accepted ? uuidv7() : null;
  const modelHash = publicationId ? hash('model') : null;
  const manifest = {
    schema_version: 3,
    generation_id: g.generationId,
    run_id: g.source.run_id,
    status: publicationId ? 'VALID' : 'REJECTED',
    attempt_count: a.record.attempt,
    final_attempt_outcome: a.record.outcome,
    model_sha256: modelHash,
    ...override,
  };
  const bytes = '\n' + JSON.stringify(manifest) + '\n';
  const op = a.operationId;
  db.prepare(
    'INSERT INTO review_semantic_terminals (generation_id,terminal_attempt_revision_id,manifest_json,manifest_sha256,model_publication_id,model_relative_path,model_sha256,model_byte_length,operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    g.generationId,
    a.revisionId,
    bytes,
    hash(bytes),
    publicationId,
    publicationId ? `evidence/${publicationId}/semantic-anchor-model-v3.json` : null,
    modelHash,
    publicationId ? 5 : null,
    op
  );
  return { op, bytes };
}
function select(db: Database.Database, g: Generation) {
  db.prepare("INSERT INTO review_semantic_current VALUES (?, ?, ?, 'VALID', 1, ?)").run(
    g.source.review_id,
    g.source.run_id,
    g.generationId,
    receipt(db)
  );
}

it('retains exact semantic JSON bytes without advancing the installed schema', () => {
  const { db, sources } = fixture(),
    g = generation(db, sources[0]!),
    a = attempt(db, g),
    t = terminal(db, g, a);
  select(db, g);
  expect(
    db.prepare('SELECT record_json,accepted,outcome FROM review_semantic_attempts').get()
  ).toEqual({ record_json: a.bytes, accepted: 1, outcome: 'ACCEPTED_CLEAN_FIRST_PASS' });
  expect(db.prepare('SELECT manifest_json,status FROM review_semantic_terminals').get()).toEqual({
    manifest_json: t.bytes,
    status: 'VALID',
  });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it.each(['review', 'run', 'terminal', 'input', 'kind'] as const)(
  'refuses a generation with foreign %s ownership',
  (field) => {
    const { db, sources } = fixture();
    const source = sources[0]!,
      other = sources[1]!;
    if (field === 'kind') {
      expect(() =>
        db
          .prepare('INSERT INTO review_semantic_generations VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(
            uuidv7(),
            source.review_id,
            source.run_id,
            source.current_revision_id,
            source.publication,
            'story',
            receipt(db)
          )
      ).toThrow();
      return;
    }
    const override =
      field === 'review'
        ? { review_id: uuidv7() }
        : field === 'run'
          ? { run_id: other.run_id }
          : field === 'terminal'
            ? { current_revision_id: other.current_revision_id }
            : { publication: other.publication };
    expect(() => generation(db, source, override)).toThrow(/FOREIGN KEY/);
  }
);

it('refuses attempts with foreign run identities and missing or accepted repair predecessors', () => {
  const { db, sources } = fixture(),
    g = generation(db, sources[0]!);
  expect(() => attempt(db, g, true, 1, { run_id: sources[1]!.run_id })).toThrow(/original run/);
  expect(() => attempt(db, g, true, 2)).toThrow(/rejected attempt/);
  attempt(db, g, true);
  expect(() => attempt(db, g, true, 2)).toThrow(/rejected attempt/);
});

it('binds admission and terminal records to their original attempt operation', () => {
  const { db, sources } = fixture(),
    g = generation(db, sources[0]!);
  const raw = JSON.stringify({
    schema_version: 3,
    generation_id: g.generationId,
    run_id: g.source.run_id,
    attempt: 1,
    accepted: true,
    outcome: 'ACCEPTED_CLEAN_FIRST_PASS',
  });
  expect(() =>
    db
      .prepare(
        'INSERT INTO review_semantic_attempts (revision_id,generation_id,attempt_number,record_json,record_sha256,operation_id) VALUES (?, ?, 1, ?, ?, ?)'
      )
      .run(uuidv7(), g.generationId, raw, hash(raw), receipt(db))
  ).toThrow(/original run/);
  const a = attempt(db, g);
  expect(() => terminal(db, g, { ...a, operationId: receipt(db) })).toThrow(/exact final attempt/);
  terminal(db, g, a);
});

it('retains one rejected attempt and one terminal repair without replacing an accepted selection', () => {
  const { db, sources } = fixture(),
    accepted = generation(db, sources[0]!);
  terminal(db, accepted, attempt(db, accepted));
  select(db, accepted);
  const g = generation(db, sources[0]!);
  attempt(db, g, false);
  const repair = attempt(db, g, false, 2);
  terminal(db, g, repair);
  expect(() => select(db, g)).toThrow();
  expect(() => attempt(db, g, true, 2)).toThrow();
  expect(() => attempt(db, g, true, 3)).toThrow();
  expect(db.prepare('SELECT generation_id FROM review_semantic_current').get()).toEqual({
    generation_id: accepted.generationId,
  });
});

it('refuses terminal records with another generation attempt or mismatched run/outcome', () => {
  const { db, sources } = fixture(),
    g = generation(db, sources[0]!),
    other = generation(db, sources[0]!);
  const a = attempt(db, g),
    b = attempt(db, other);
  expect(() => terminal(db, g, b)).toThrow(/exact final attempt/);
  expect(() => terminal(db, g, a, { run_id: sources[1]!.run_id })).toThrow(/exact final attempt/);
  expect(() => terminal(db, g, a, { final_attempt_outcome: 'ACCEPTED_REPAIRED' })).toThrow(
    /exact final attempt/
  );
});

it('refuses pending, foreign-run and rejected current selections', () => {
  const { db, sources } = fixture(),
    g = generation(db, sources[0]!);
  attempt(db, g, false);
  expect(() => select(db, g)).toThrow(/FOREIGN KEY/);
  terminal(db, g, attempt(db, g, false, 2));
  expect(() => select(db, g)).toThrow(/FOREIGN KEY/);
  const valid = generation(db, sources[1]!);
  terminal(db, valid, attempt(db, valid));
  expect(() => select(db, { ...valid, source: sources[0]! })).toThrow(/FOREIGN KEY/);
});

it.each(['review_semantic_generations', 'review_semantic_attempts', 'review_semantic_terminals'])(
  'protects %s against update deletion and replacement',
  (table) => {
    const { db, sources } = fixture(),
      g = generation(db, sources[0]!);
    terminal(db, g, attempt(db, g));
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    expect(() => db.exec(`UPDATE ${table} SET generation_id=generation_id`)).toThrow(/immutable/);
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/retained/);
    const columns = (
      db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[]
    )
      .filter((row) => row.hidden === 0)
      .map((row) => row.name)
      .join(',');
    expect(() =>
      db.exec(`INSERT OR REPLACE INTO ${table} (${columns}) SELECT ${columns} FROM ${table}`)
    ).toThrow();
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
  }
);

it('rolls back an unsettled operation receipt and retains the original submission owner', () => {
  const { db, sources } = fixture(),
    g = generation(db, sources[0]!);
  attempt(db, g, false);
  const before = db.prepare('SELECT * FROM project_counters').get();
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    'INSERT INTO review_semantic_attempts (revision_id,generation_id,attempt_number,record_json,record_sha256,operation_id) VALUES (?, ?, 2, ?, ?, ?)'
  ).run(
    uuidv7(),
    g.generationId,
    JSON.stringify({
      schema_version: 3,
      generation_id: g.generationId,
      run_id: g.source.run_id,
      attempt: 2,
      accepted: false,
      outcome: 'TERMINAL_REJECTED',
    }),
    hash('fixture'),
    uuidv7()
  );
  expect(() => db.exec('COMMIT')).toThrow(/FOREIGN KEY/);
  expect(db.inTransaction).toBe(true);
  db.exec('ROLLBACK');
  expect(db.prepare('SELECT attempt_number FROM review_semantic_attempts').all()).toEqual([
    { attempt_number: 1 },
  ]);
  expect(db.prepare('SELECT * FROM project_counters').get()).toEqual(before);
  expect(
    db
      .prepare("SELECT payload_json FROM operations WHERE operation_kind='review.semantic.fixture'")
      .all()
  ).toSatisfy((rows: { payload_json: string }[]) =>
    rows.every(
      (row) => Object.keys(JSON.parse(row.payload_json)).join(',') === 'rawSubmissionSha256'
    )
  );
});

function currentTarget(db: Database.Database, source: Source) {
  return db
    .prepare(
      `SELECT r.current_revision_id AS revision, r.version, c.run_selection_version AS selection
FROM review_runs r JOIN review_selections c ON c.review_id=r.review_id AND c.current_run_id=r.run_id
WHERE r.review_id=? AND r.run_id=?`
    )
    .get(source.review_id, source.run_id) as {
    revision: string;
    version: number;
    selection: number;
  };
}
function settleSelection(
  db: Database.Database,
  g: Generation,
  expected: ReturnType<typeof currentTarget>,
  previous: { generation: string; version: number } | null
) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const target = currentTarget(db, g.source);
    if (
      !target ||
      target.revision !== expected.revision ||
      target.version !== expected.version ||
      target.selection !== expected.selection
    )
      throw new Error('STALE_CONTEXT');
    const operation = receipt(db);
    if (previous) {
      const changed = db
        .prepare(
          `UPDATE review_semantic_current SET generation_id=?,version=version+1,operation_id=?
WHERE review_id=? AND run_id=? AND generation_id=? AND version=?`
        )
        .run(
          g.generationId,
          operation,
          g.source.review_id,
          g.source.run_id,
          previous.generation,
          previous.version
        );
      if (changed.changes !== 1) throw new Error('STALE_CONTEXT');
    } else {
      if (
        db
          .prepare('SELECT 1 FROM review_semantic_current WHERE review_id=? AND run_id=?')
          .get(g.source.review_id, g.source.run_id)
      )
        throw new Error('STALE_CONTEXT');
      db.prepare("INSERT INTO review_semantic_current VALUES (?, ?, ?, 'VALID', 1, ?)").run(
        g.source.review_id,
        g.source.run_id,
        g.generationId,
        operation
      );
    }
    db.exec('UPDATE project_counters SET write_sequence=write_sequence+1 WHERE singleton=1');
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

it('uses original run and semantic selection compare-and-swap without advancing intent', () => {
  const { db, sources } = fixture();
  const source = sources.find((s) => currentTarget(db, s))!;
  const g = generation(db, source);
  terminal(db, g, attempt(db, g));
  const expected = currentTarget(db, source);
  const before = db.prepare('SELECT * FROM project_counters').get() as {
    write_sequence: number;
    intent_change_counter: number;
    singleton: number;
  };
  expect(() =>
    settleSelection(db, g, { ...expected, version: expected.version + 1 }, null)
  ).toThrow('STALE_CONTEXT');
  expect(() => settleSelection(db, g, { ...expected, revision: uuidv7() }, null)).toThrow(
    'STALE_CONTEXT'
  );
  expect(() =>
    settleSelection(db, g, { ...expected, selection: expected.selection + 1 }, null)
  ).toThrow('STALE_CONTEXT');
  expect(db.prepare('SELECT * FROM project_counters').get()).toEqual(before);
  settleSelection(db, g, expected, null);
  const next = generation(db, source);
  terminal(db, next, attempt(db, next));
  const operationCount = db.prepare('SELECT count(*) AS count FROM operations').get();
  expect(() => settleSelection(db, next, expected, null)).toThrow('STALE_CONTEXT');
  expect(() =>
    settleSelection(db, next, expected, { generation: g.generationId, version: 0 })
  ).toThrow('STALE_CONTEXT');
  expect(db.prepare('SELECT count(*) AS count FROM operations').get()).toEqual(operationCount);
  settleSelection(db, next, expected, { generation: g.generationId, version: 1 });
  expect(db.prepare('SELECT generation_id,version FROM review_semantic_current').get()).toEqual({
    generation_id: next.generationId,
    version: 2,
  });
  expect(db.prepare('SELECT * FROM project_counters').get()).toEqual({
    ...before,
    write_sequence: before.write_sequence + 2,
  });
  const other = sources.find((s) => s.run_id !== source.run_id)!;
  db.prepare(
    'UPDATE review_selections SET current_run_id=?,run_selection_version=run_selection_version+1 WHERE review_id=?'
  ).run(other.run_id, source.review_id);
  expect(() =>
    settleSelection(db, g, expected, { generation: next.generationId, version: 2 })
  ).toThrow('STALE_CONTEXT');
  expect(db.prepare('SELECT generation_id FROM review_semantic_current').get()).toEqual({
    generation_id: next.generationId,
  });
});
