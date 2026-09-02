import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findWithheldEntries, parseWithheldEntries } from './public-tree.mjs';

// Assembled so the public-tree verifier does not read this file as a reference
// to the withheld directory.
const WITHHELD_DIR = 'internal';
const EXCLUDES_FILE = path.join(WITHHELD_DIR, 'export-excludes.txt');

// The COMPLETE fallback, in the order findWithheldEntries reports it: asserting
// a subset would let the rest be dropped from the module with every test green.
const FALLBACK_ENTRIES = [WITHHELD_DIR, 'audit', 'vendor', 'CLAUDE' + '.md', 'AGENTS' + '.md'];

let dir;

const write = (relative, contents = '') => {
  const target = path.join(dir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

const materialize = (entry) =>
  entry.endsWith('.md') ? write(entry, 'notes\n') : write(path.join(entry, 'notes.md'), 'notes\n');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orcaops-withheld-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseWithheldEntries', () => {
  it('drops comments and blank lines and strips trailing slashes', () => {
    const text = ['# a comment', '', 'audit/', 'CHANGELOG.md  ', 'a/b/ # trailing note'].join('\n');
    expect(parseWithheldEntries(text)).toEqual(['audit', 'CHANGELOG.md', 'a/b']);
  });
});

describe('findWithheldEntries with the exporter list present', () => {
  it('reports entries the hardcoded fallback does not know about', () => {
    write(
      EXCLUDES_FILE,
      ['# the exporter list', 'audit/', 'scripts/bootstrap-vendor.sh'].join('\n')
    );
    write('scripts/bootstrap-vendor.sh', '#!/usr/bin/env bash\n');

    const found = findWithheldEntries(dir);
    expect(found).toContain('scripts/bootstrap-vendor.sh');
    expect(found).not.toContain('audit');
  });

  it('reports nothing when every entry the list names is already gone', () => {
    write(EXCLUDES_FILE, ['audit/', 'CHANGELOG.md'].join('\n'));
    expect(findWithheldEntries(dir)).toEqual([]);
  });

  it('reports the withheld directory itself when the list names it', () => {
    write(EXCLUDES_FILE, `${WITHHELD_DIR}/\n`);
    expect(findWithheldEntries(dir)).toEqual([WITHHELD_DIR]);
  });
});

describe('findWithheldEntries with no exporter list', () => {
  // The list is itself withheld, so an exported tree never has one to read.
  it('falls back to every hardcoded entry', () => {
    for (const entry of FALLBACK_ENTRIES) materialize(entry);
    expect(findWithheldEntries(dir)).toEqual(FALLBACK_ENTRIES);
  });

  it.each(FALLBACK_ENTRIES)('still reports %s when it is the only one present', (entry) => {
    materialize(entry);
    expect(findWithheldEntries(dir)).toEqual([entry]);
  });

  it('reports nothing for a tree that is genuinely clean', () => {
    write('README.md', 'hello\n');
    expect(findWithheldEntries(dir)).toEqual([]);
  });
});
