import { describe, expect, it } from 'vitest';

import type { DiffFingerprintHunk } from '@orcaops/diff-fingerprint';

import { indexParsedHunks, parseChangedRows } from './changedRows.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function fpHunk(overrides: Partial<DiffFingerprintHunk>): DiffFingerprintHunk {
  return {
    hunk_index: 0,
    file_before: 'src/a.ts',
    file_after: 'src/a.ts',
    change_type: 'modify',
    old_start: 1,
    old_lines: 1,
    new_start: 1,
    new_lines: 1,
    binary: false,
    patch_hash: 'ph',
    added_line_hashes: [],
    deleted_line_hashes: [],
    hunk_header_hash: null,
    added_line_count: 0,
    deleted_line_count: 0,
    ...overrides,
  } as DiffFingerprintHunk;
}

describe('parseChangedRows — sign column versus file header', () => {
  // `--` and `++` are the comment tokens in SQL, Lua, Haskell, Elm and Ada. A
  // deleted `-- ` line renders as `--- `, and reading that as a file header
  // cleared the hunk and dropped every row behind it — so this parser reported
  // zero changed rows while the diff fingerprint counted them, and coverage
  // failed the whole file closed to UNREVIEWABLE.
  it('counts a row that renders as a file header', () => {
    const diff = [
      'diff --git a/migrate.sql b/migrate.sql',
      '--- a/migrate.sql',
      '+++ b/migrate.sql',
      '@@ -1,4 +1,4 @@',
      ' BEGIN;',
      '--- api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds',
      ' CREATE TABLE charges (id uuid primary key);',
      '+++ read the credential from the environment',
      ' COMMIT;',
      '',
    ].join('\n');
    const [hunk] = parseChangedRows(enc(diff));
    expect(hunk?.coverageFile).toBe('migrate.sql');
    expect(hunk?.deletedRows).toBe(1);
    expect(hunk?.addedRows).toBe(1);
    expect(hunk?.rows.map((r) => [r.side, r.line])).toEqual([
      ['delete', 2],
      ['add', 3],
    ]);
  });

  it('reads the next file header as a header once the hunk ends', () => {
    const diff = [
      'diff --git a/a.sql b/a.sql',
      '--- a/a.sql',
      '+++ b/a.sql',
      '@@ -1,1 +1,1 @@',
      '-- first',
      'diff --git a/b.sql b/b.sql',
      '--- a/b.sql',
      '+++ b/b.sql',
      '@@ -1,2 +1,2 @@',
      ' SELECT 2;',
      '+SELECT 3;',
      '',
    ].join('\n');
    const hunks = parseChangedRows(enc(diff));
    expect(hunks.map((h) => h.coverageFile)).toEqual(['a.sql', 'b.sql']);
    expect(hunks[1]?.addedRows).toBe(1);
  });
});

describe('parseChangedRows', () => {
  it('emits changed rows with both coordinates; context advances patchRow only', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,4 +3,5 @@',
      ' ctx1', //      old3/new3  patchRow 0
      '-gone', //      old4       patchRow 1
      '+addA', //      new4       patchRow 2
      '+addB', //      new5       patchRow 3
      ' ctx2', //      old5/new6  patchRow 4
      ' ctx3', //      old6/new7  patchRow 5
      '',
    ].join('\n');
    const hunks = parseChangedRows(enc(diff));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      coverageFile: 'src/a.ts',
      oldStart: 3,
      newStart: 3,
      addedRows: 2,
      deletedRows: 1,
    });
    expect(hunks[0].rows).toEqual([
      { side: 'delete', line: 4, patchRow: 1, body: 'gone' },
      { side: 'add', line: 4, patchRow: 2, body: 'addA' },
      { side: 'add', line: 5, patchRow: 3, body: 'addB' },
    ]);
  });

  it('does not advance patchRow on the no-newline marker', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const rows = parseChangedRows(enc(diff))[0].rows;
    // The marker is not a row: -old and +new stay patchRow-consecutive.
    expect(rows).toEqual([
      { side: 'delete', line: 1, patchRow: 0, body: 'old' },
      { side: 'add', line: 1, patchRow: 1, body: 'new' },
    ]);
  });

  it('keys renamed files by the NEW path and deleted files by the old one', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,2 +1,1 @@',
      ' keep',
      '-dropped',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
      '',
    ].join('\n');
    const hunks = parseChangedRows(enc(diff));
    expect(hunks.map((h) => h.coverageFile)).toEqual(['new.ts', 'gone.ts']);
    // Delete-side line numbers are old-file numbering.
    expect(hunks[0].rows).toEqual([{ side: 'delete', line: 2, patchRow: 1, body: 'dropped' }]);
    expect(hunks[1].rows).toEqual([{ side: 'delete', line: 1, patchRow: 0, body: 'bye' }]);
  });

  it('parses repeated identical hunk bodies at distinct positions', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,2 @@',
      ' ctx',
      '+same',
      '@@ -10,1 +11,2 @@',
      ' ctx',
      '+same',
      '',
    ].join('\n');
    const hunks = parseChangedRows(enc(diff));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(hunks[1]).toMatchObject({ oldStart: 10, newStart: 11 });
  });

  it('yields no hunks for binary or empty input', () => {
    const binary = [
      'diff --git a/logo.png b/logo.png',
      'index 0000000..1111111 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    expect(parseChangedRows(enc(binary))).toEqual([]);
    expect(parseChangedRows(enc(''))).toEqual([]);
  });
});

describe('indexParsedHunks — the fail-closed cross-check', () => {
  const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,2 @@',
    ' ctx',
    '+row',
    '',
  ].join('\n');

  it('takes an aligned hunk exactly once', () => {
    const lookup = indexParsedHunks(parseChangedRows(enc(DIFF)));
    const hunk = fpHunk({ old_start: 1, new_start: 1, added_line_count: 1 });
    const first = lookup.take(hunk);
    expect(first?.rows).toEqual([{ side: 'add', line: 2, patchRow: 1, body: 'row' }]);
    // A duplicate take fails closed — never serve the same rows twice.
    expect(lookup.take(hunk)).toBeNull();
  });

  it('fails closed on a missing hunk (no parse at the coordinates)', () => {
    const lookup = indexParsedHunks(parseChangedRows(enc(DIFF)));
    expect(lookup.take(fpHunk({ old_start: 7, new_start: 7, added_line_count: 1 }))).toBeNull();
  });

  it('fails closed on a changed-row count mismatch', () => {
    const lookup = indexParsedHunks(parseChangedRows(enc(DIFF)));
    expect(lookup.take(fpHunk({ old_start: 1, new_start: 1, added_line_count: 2 }))).toBeNull();
  });

  it('fails closed on a pathless hunk', () => {
    const lookup = indexParsedHunks(parseChangedRows(enc(DIFF)));
    expect(lookup.take(fpHunk({ file_before: null, file_after: null }))).toBeNull();
  });
});
