import { describe, expect, it } from 'vitest';

import { parseDiffLinePositions } from './diffLines.js';

const enc = (lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

describe('parseDiffLinePositions — sign column versus file header', () => {
  it('keeps positions for rows that render as file headers', () => {
    // A deleted `-- ` comment renders as `--- `. Read as a header it ended the
    // hunk, so every position behind it in the file was dropped.
    const positions = parseDiffLinePositions(
      enc([
        'diff --git a/migrate.sql b/migrate.sql',
        '--- a/migrate.sql',
        '+++ b/migrate.sql',
        '@@ -1,4 +1,4 @@',
        ' BEGIN;',
        '--- api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds',
        ' CREATE TABLE charges (id uuid primary key);',
        '+CREATE INDEX charges_id_idx ON charges (id);',
        ' COMMIT;',
        '',
      ])
    );
    expect(positions.map((p) => [p.side, p.line, p.body])).toEqual([
      ['delete', 2, '-- api_key=R7mKq2XvT4bNw9ZcJ5hLp3Ds'],
      ['add', 3, 'CREATE INDEX charges_id_idx ON charges (id);'],
    ]);
  });

  it('reads the next file header as a header once the hunk ends', () => {
    const positions = parseDiffLinePositions(
      enc([
        'diff --git a/a.sql b/a.sql',
        '--- a/a.sql',
        '+++ b/a.sql',
        '@@ -1,1 +1,1 @@',
        '-- first',
        'diff --git a/b.sql b/b.sql',
        '--- a/b.sql',
        '+++ b/b.sql',
        '@@ -1,1 +1,2 @@',
        '+SELECT 3;',
        '',
      ])
    );
    expect(positions.map((p) => [p.file, p.side])).toEqual([
      ['a.sql', 'delete'],
      ['b.sql', 'add'],
    ]);
  });
});

describe('parseDiffLinePositions', () => {
  it('tracks add/delete line numbers through context', () => {
    const positions = parseDiffLinePositions(
      enc([
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -4,3 +4,4 @@',
        ' line4', // context: old4/new4
        '+added5', // add at new5
        ' line5', // context: old5/new6
        '-line6', // delete at old6
        '+line6new', // add at new7
        '',
      ])
    );
    expect(positions).toEqual([
      { file: 'src/a.ts', side: 'add', line: 5, coverageFile: 'src/a.ts', body: 'added5' },
      { file: 'src/a.ts', side: 'delete', line: 6, coverageFile: 'src/a.ts', body: 'line6' },
      { file: 'src/a.ts', side: 'add', line: 7, coverageFile: 'src/a.ts', body: 'line6new' },
    ]);
  });

  it('handles a new file (/dev/null old side) and multiple hunks/files', () => {
    const positions = parseDiffLinePositions(
      enc([
        'diff --git a/src/new.ts b/src/new.ts',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1,2 @@',
        '+first',
        '+second',
        'diff --git a/src/multi.ts b/src/multi.ts',
        '--- a/src/multi.ts',
        '+++ b/src/multi.ts',
        '@@ -10,1 +10,2 @@',
        ' keep',
        '+eleven',
        '@@ -20,1 +21,2 @@',
        ' keep20',
        '+twentytwo',
        '',
      ])
    );
    expect(positions).toEqual([
      { file: 'src/new.ts', side: 'add', line: 1, coverageFile: 'src/new.ts', body: 'first' },
      { file: 'src/new.ts', side: 'add', line: 2, coverageFile: 'src/new.ts', body: 'second' },
      { file: 'src/multi.ts', side: 'add', line: 11, coverageFile: 'src/multi.ts', body: 'eleven' },
      {
        file: 'src/multi.ts',
        side: 'add',
        line: 22,
        coverageFile: 'src/multi.ts',
        body: 'twentytwo',
      },
    ]);
  });

  it('drops deletions against /dev/null (pure delete) onto the old path', () => {
    const positions = parseDiffLinePositions(
      enc([
        'diff --git a/gone.ts b/gone.ts',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-a',
        '-b',
        '',
      ])
    );
    // A deleted file has no new path: coverageFile falls back to the old one —
    // exactly how the engine keys the pure-deletion hunk (file_after is null).
    expect(positions).toEqual([
      { file: 'gone.ts', side: 'delete', line: 1, coverageFile: 'gone.ts', body: 'a' },
      { file: 'gone.ts', side: 'delete', line: 2, coverageFile: 'gone.ts', body: 'b' },
    ]);
  });

  it('keys a renamed file: deletes blame the OLD path but cover the NEW one', () => {
    const positions = parseDiffLinePositions(
      enc([
        'diff --git a/old/name.ts b/new/name.ts',
        'similarity index 75%',
        'rename from old/name.ts',
        'rename to new/name.ts',
        '--- a/old/name.ts',
        '+++ b/new/name.ts',
        '@@ -1,3 +1,2 @@',
        ' keep',
        '-dropped',
        ' keep2',
        '',
      ])
    );
    expect(positions).toEqual([
      {
        file: 'old/name.ts',
        side: 'delete',
        line: 2,
        coverageFile: 'new/name.ts',
        body: 'dropped',
      },
    ]);
  });

  it('ignores hunk headers with omitted counts (single-line form)', () => {
    const positions = parseDiffLinePositions(
      enc(['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-old', '+new', ''])
    );
    expect(positions).toEqual([
      { file: 'x.ts', side: 'delete', line: 1, coverageFile: 'x.ts', body: 'old' },
      { file: 'x.ts', side: 'add', line: 1, coverageFile: 'x.ts', body: 'new' },
    ]);
  });
});
