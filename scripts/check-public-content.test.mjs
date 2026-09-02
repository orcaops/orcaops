import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkPublicContent,
  findPublicContentViolations,
  parseExcludePathspecs,
} from './check-public-content.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-public-content.mjs');

// This file ships and the scanner scans it, so every fixture is assembled from
// fragments and numbered outside the real range: a literal needle, or a real
// finding id, would leak the very ledger the gate keeps out of the public tree.
const FORBIDDEN = {
  'audit identifier': 'PUB-' + '999',
  'cloud repository name': 'orcaops' + '-cloud',
  'handoff staging area': 'launch' + '-handoff',
  'maintainer handle': '@' + 'leviops',
  'home path': '/' + 'Users/someone/code',
  'worktree root': '/' + 'home/x/.' + 'superset/projects',
};

// A rule narrowed later still passes against a bare needle on its own line;
// these are the same needles in the shapes real source puts them in.
const LEAK_SHAPES = [
  [
    'a file-header comment',
    ` * Outbound network policy for every cloud request (PUB-${'9'}99, PUB-${'9'}98).`,
  ],
  ['an inline note', `  // which is the other half of what CR-${'9'}97 asks for.`],
  [
    'a prose reference in docs',
    `- Path containment and id validation stay independent (RR-${'9'}96/C2).`,
  ],
  ['a CODEOWNERS line', `* @${'leviops'}`],
  ['an owner field in JSON', `      "owner": "@${'leviops'}",`],
  ['a repository name in prose', `Requires a private sibling clone of ${'orcaops'}-cloud to run.`],
  [
    'a staging path in prose',
    `\`scripts/bootstrap-vendor.sh\` runs against an audited \`.${'launch'}-handoff/\` staging area`,
  ],
  [
    'a docstring example',
    ` * with \`-\` (e.g. \`/${'Users'}/x/.foo\` -> \`-Users-x--foo\`). Used only as a scan`,
  ],
  ['a worktree path in a fixture', `const root = '/${'home'}/x/.${'superset'}/projects/demo';`],
];

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orcaops-public-content-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseExcludePathspecs', () => {
  it('drops comments and blank lines and strips trailing slashes', () => {
    const text = ['# a comment', '', 'audit/', 'CHANGELOG.md  ', 'a/b/ # trailing note'].join('\n');
    expect(parseExcludePathspecs(text)).toEqual([':!audit', ':!CHANGELOG.md', ':!a/b']);
  });
});

describe('findPublicContentViolations', () => {
  it.each(Object.entries(FORBIDDEN))('reports a %s with its file and line', (_label, needle) => {
    writeFileSync(path.join(dir, 'note.md'), `clean line\nleaks ${needle} here\n`);
    const { findings } = findPublicContentViolations(dir, ['note.md']);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^note\.md:2: /);
  });

  it('trips a different rule for each fixture', () => {
    writeFileSync(path.join(dir, 'note.md'), `${Object.values(FORBIDDEN).join(' ')}\n`);
    const { findings } = findPublicContentViolations(dir, ['note.md']);
    expect(findings).toHaveLength(Object.keys(FORBIDDEN).length);
    const labels = new Set(findings.map((finding) => finding.replace(/^note\.md:1: /, '')));
    expect(labels.size).toBe(Object.keys(FORBIDDEN).length);
  });

  it('accepts a tree with nothing forbidden in it', () => {
    writeFileSync(path.join(dir, 'note.md'), 'nothing to see here\n');
    expect(findPublicContentViolations(dir, ['note.md'])).toEqual({ findings: [], scanned: 1 });
  });

  it('skips binary files instead of matching bytes inside them', () => {
    const needle = Buffer.from(FORBIDDEN['audit identifier'], 'utf8');
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0x00, 0x01]), needle]));
    expect(findPublicContentViolations(dir, ['blob.bin'])).toEqual({ findings: [], scanned: 0 });
  });

  it('does not follow a symlink into a file it would otherwise reject', () => {
    writeFileSync(path.join(dir, 'real.md'), `${FORBIDDEN['maintainer handle']}\n`);
    symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link.md'));
    expect(findPublicContentViolations(dir, ['link.md'])).toEqual({ findings: [], scanned: 0 });
  });

  it('allows a temp-directory prefix that merely starts with the cloud repository name', () => {
    writeFileSync(path.join(dir, 'note.md'), `mkdtemp('${'orcaops' + '-cloudsync-'}')\n`);
    expect(findPublicContentViolations(dir, ['note.md']).findings).toEqual([]);
  });

  it.each(LEAK_SHAPES)('reports a leak written as %s', (_shape, line) => {
    writeFileSync(path.join(dir, 'note.txt'), `harmless first line\n${line}\n`);
    const { findings } = findPublicContentViolations(dir, ['note.txt']);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]).toMatch(/^note\.txt:2: /);
  });

  it('reports every rule a single line trips', () => {
    const line = `${FORBIDDEN['audit identifier']} ${FORBIDDEN['maintainer handle']}`;
    writeFileSync(path.join(dir, 'note.md'), `${line}\n`);
    expect(findPublicContentViolations(dir, ['note.md']).findings).toHaveLength(2);
  });
});

// Every scheme, at the digit width its ledger actually uses.
const AUDIT_ID_SCHEMES = [
  ['AE', 'AE-' + '99'],
  ['CLI', 'CLI-' + '99'],
  ['CR', 'CR-' + '999'],
  ['EVAL', 'EVAL-' + '99'],
  ['GT', 'GT-' + '99'],
  ['HYG', 'HYG-' + '999'],
  ['INV', 'INV-' + '999'],
  ['OPS', 'OPS-' + '999'],
  ['POL', 'POL-' + '999'],
  ['PUB', 'PUB-' + '999'],
  ['REM', 'REM-' + '999'],
  ['RR', 'RR-' + '999'],
  ['SB', 'SB-' + '99'],
];

// Scheme-shaped product vocabulary, and the reason SHA is absent from the rule:
// every `SHA-<digits>` in the ledgers is a digest, not a finding id.
const PRODUCT_VOCABULARY = [
  ['a SHA-256 digest', 'per-line SHA-256 checksum over the canonical JSON'],
  ['a SHA-512 digest', 'staged against their SHA-512 identities'],
  ['a one-digit identifier', 'see CR-1 in the notes'],
];

describe('the audit identifier rule', () => {
  it.each(AUDIT_ID_SCHEMES)('reports a leaked %s identifier', (_scheme, needle) => {
    writeFileSync(path.join(dir, 'note.md'), `clean line\nleaks ${needle} here\n`);
    const { findings } = findPublicContentViolations(dir, ['note.md']);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('internal audit identifier');
  });

  it.each(PRODUCT_VOCABULARY)('does not report %s', (_label, line) => {
    writeFileSync(path.join(dir, 'note.md'), `${line}\n`);
    expect(findPublicContentViolations(dir, ['note.md']).findings).toEqual([]);
  });

  it('reports a four-digit identifier', () => {
    writeFileSync(path.join(dir, 'note.md'), `leaks ${'REM-' + '9999'} here\n`);
    expect(findPublicContentViolations(dir, ['note.md']).findings).toHaveLength(1);
  });

  it('reports an identifier whose digits run past the range', () => {
    writeFileSync(path.join(dir, 'note.md'), `leaks ${'REM-' + '99999'} here\n`);
    expect(findPublicContentViolations(dir, ['note.md']).findings).toHaveLength(1);
  });

  it('covers every scheme through the audit identifier rule', () => {
    const needles = AUDIT_ID_SCHEMES.map(([, needle]) => needle);
    writeFileSync(path.join(dir, 'note.md'), `${needles.join('\n')}\n`);
    const { findings } = findPublicContentViolations(dir, ['note.md']);
    expect(findings).toHaveLength(needles.length);
    for (const [index, finding] of findings.entries()) {
      expect(finding).toContain('internal audit identifier');
      expect(finding).toMatch(new RegExp(`^note\\.md:${index + 1}: `));
    }
  });
});

describe('checkPublicContent over a repository', () => {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };

  const initRepo = () => {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Public Content Test');
    git('config', 'user.email', 'public-content@example.invalid');
  };

  it('honours the export exclusions when deciding what ships', () => {
    initRepo();
    writeFileSync(path.join(dir, 'shipped.md'), 'clean\n');
    writeFileSync(path.join(dir, 'withheld.md'), `${FORBIDDEN['audit identifier']}\n`);
    const excludesDir = path.join(dir, 'internal');
    mkdirSync(excludesDir, { recursive: true });
    writeFileSync(path.join(excludesDir, 'export-excludes.txt'), '# note\nwithheld.md\n');
    git('add', '--all');

    expect(checkPublicContent(dir).findings).toEqual([]);
  });

  it('exits non-zero and names file:line when a tracked file leaks', () => {
    initRepo();
    writeFileSync(path.join(dir, 'shipped.md'), `first\n${FORBIDDEN['handoff staging area']}\n`);
    git('add', '--all');

    const run = spawnSync(process.execPath, [scriptPath, dir], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('shipped.md:2:');
  });

  it('exits non-zero when the tree has no tracked files to scan', () => {
    initRepo();
    writeFileSync(path.join(dir, 'untracked.md'), 'never staged\n');

    const run = spawnSync(process.execPath, [scriptPath, dir], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('scanned 0 text files');
    expect(run.stdout).not.toContain('Public content OK');
  });

  it('exits zero on a clean tracked tree', () => {
    initRepo();
    writeFileSync(path.join(dir, 'shipped.md'), 'nothing forbidden\n');
    git('add', '--all');

    const run = spawnSync(process.execPath, [scriptPath, dir], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Public content OK');
  });
});

describe('the shipped tree itself', () => {
  it('carries no forbidden content', () => {
    expect(checkPublicContent(repoRoot).findings).toEqual([]);
  });
});
