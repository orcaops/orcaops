#!/usr/bin/env node
// Content gate for the tree that ships publicly.
//
// Every needle below is assembled from fragments, never written literally: this
// file ships and the scanner scans it, so a literal needle would report this
// file forever and the only cure would be exempting the scanner from its scan.

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXCLUDES_FILE = path.join('internal', 'export-excludes.txt');
const MAX_ECHOED_LINE = 160;

const RULES = [
  {
    // SHA is deliberately absent: it looks like a scheme, but every
    // `SHA-<digits>` in the ledgers is SHA-256 or SHA-512, not a finding id.
    label: 'internal audit identifier',
    pattern: /\b(?:AE|CLI|CR|EVAL|GT|HYG|INV|OPS|POL|PUB|REM|RR|SB)-\d{2,4}/,
  },
  {
    // Trailing guard: test fixtures legitimately prefix temp dirs with this
    // name plus more word characters. Only the bare repository name leaks.
    label: 'private cloud repository name',
    pattern: new RegExp('orcaops' + '-cloud(?![-\\w])'),
  },
  {
    label: 'private vendor handoff staging area',
    pattern: new RegExp('launch' + '-handoff'),
  },
  {
    label: 'individual maintainer handle',
    pattern: new RegExp('@' + 'leviops\\b'),
  },
  {
    label: 'absolute macOS home path',
    pattern: new RegExp('/' + 'Users/'),
  },
  {
    label: 'local worktree root',
    pattern: new RegExp('\\.' + 'superset'),
  },
];

// The same comment, trimming and trailing-slash rules the export script
// applies, so the two agree on what "shipped" means.
export function parseExcludePathspecs(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .map((entry) => `:!${entry.replace(/\/+$/, '')}`);
}

function readExcludePathspecs(repoRoot) {
  try {
    return parseExcludePathspecs(readFileSync(path.join(repoRoot, EXCLUDES_FILE), 'utf8'));
  } catch (error) {
    // An exported tree has no exclusion list: every tracked file in it ships.
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function listShippedFiles(repoRoot) {
  const pathspecs = readExcludePathspecs(repoRoot);
  const listed = spawnSync('git', ['ls-files', '-z', '--', '.', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  }
  return listed.stdout.split('\0').filter(Boolean);
}

export function findPublicContentViolations(rootDir, files) {
  const findings = [];
  let scanned = 0;
  for (const relative of files) {
    const absolute = path.join(rootDir, relative);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    scanned += 1;
    const text = bytes.toString('utf8');
    for (const [index, line] of text.split('\n').entries()) {
      for (const rule of RULES) {
        const match = rule.pattern.exec(line);
        if (match === null) continue;
        const excerpt = line.trim().slice(0, MAX_ECHOED_LINE);
        findings.push(`${relative}:${index + 1}: ${rule.label} (${match[0]}): ${excerpt}`);
      }
    }
  }
  return { findings, scanned };
}

export function checkPublicContent(repoRoot) {
  return findPublicContentViolations(repoRoot, listShippedFiles(repoRoot));
}

function main() {
  const repoRoot =
    process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { findings, scanned } = checkPublicContent(repoRoot);

  if (scanned === 0) {
    console.error(
      'Public content check failed: it scanned 0 text files, so it proved nothing.\n\n' +
        '  This usually means the tree has no tracked files (an empty or unstaged git\n' +
        '  index), or the path given is not the repository root. Stage the tree and\n' +
        '  re-run; do not treat this as a pass.'
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(`Public content check failed with ${findings.length} finding(s):\n`);
    for (const finding of findings) console.error(`  - ${finding}`);
    console.error(
      '\nRewrite the offending text, or withhold the file by listing it in the export exclusions.'
    );
    process.exit(1);
  }
  console.log(`Public content OK (${scanned} text files scanned).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
