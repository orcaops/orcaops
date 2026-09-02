import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

// Construct the forbidden path token so this verifier does not report its own sentinel.
const INTERNAL_PREFIX = 'internal' + '/';
const QUALIFIER_COPY_MESSAGES = ['contains ', 'forbidden ', 'without '].map(
  (prefix) => `${prefix}${INTERNAL_PREFIX}`
);

function listRepositoryFiles(repoRoot) {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  }
  return listed.stdout.split('\0').filter(Boolean);
}

const EXCLUDES_FILE = path.join(INTERNAL_PREFIX.slice(0, -1), 'export-excludes.txt');

// Used when the tree does not carry the exporter's exclusion list — which is
// itself withheld, so a shipped verifier cannot depend on it. Tokens are
// assembled from fragments so this verifier does not report itself.
const FALLBACK_WITHHELD_ENTRIES = [
  INTERNAL_PREFIX.slice(0, -1),
  'audit',
  'vendor',
  'CLAUDE' + '.md',
  'AGENTS' + '.md',
];

// The same comment, trimming and trailing-slash rules the exporter applies, so
// the two agree on what "withheld" means.
export function parseWithheldEntries(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .map((entry) => entry.replace(/\/+$/, ''));
}

// The exporter's own list when the tree still has it; the fallback covers only
// a third of the withheld entries, so a half-finished export can pass on it.
function withheldEntriesFor(repoRoot) {
  try {
    return parseWithheldEntries(readFileSync(path.join(repoRoot, EXCLUDES_FILE), 'utf8'));
  } catch (error) {
    // Only ENOENT means "exported tree, nothing left to exclude"; any other
    // read failure must not be read as "nothing is withheld".
    if (error && error.code === 'ENOENT') return FALLBACK_WITHHELD_ENTRIES;
    throw error;
  }
}

// A precondition, not a filter: the fix for a non-empty result is to qualify the
// exported tree, never to widen the copy filter below to match the exporter.
export function findWithheldEntries(repoRoot) {
  return withheldEntriesFor(repoRoot).filter((entry) => existsSync(path.join(repoRoot, entry)));
}

export function copyPublicTree(repoRoot, destination) {
  const copied = [];
  for (const relative of listRepositoryFiles(repoRoot)) {
    if (relative === 'internal' || relative.startsWith(INTERNAL_PREFIX)) continue;
    const source = path.join(repoRoot, relative);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, {
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    copied.push(relative);
  }
  return copied;
}

function shouldScan(relative) {
  return !relative.startsWith('audit/');
}

function isCopyBoundaryReference(relative, line) {
  if (relative === 'scripts/qualify-public-release.mjs') {
    return QUALIFIER_COPY_MESSAGES.some((message) => line.includes(message));
  }
  return false;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..')
  );
}

export function findForbiddenInternalReferences(rootDir, files) {
  const findings = [];
  const canonicalRoot = realpathSync(rootDir);
  for (const relative of files) {
    const absolute = path.join(rootDir, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      try {
        const resolved = realpathSync(absolute);
        if (!isWithin(canonicalRoot, resolved)) {
          findings.push(`${relative}: symlink target ${target} resolves outside the public tree`);
        }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown';
        findings.push(`${relative}: symlink target ${target} cannot be resolved (${code})`);
      }
      continue;
    }
    if (!shouldScan(relative)) continue;
    if (!stat.isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const [index, line] of text.split('\n').entries()) {
      if (
        (/(^|[^A-Za-z0-9_])internal[/\\]/.test(line) ||
          /(^|[\s"'`=(,])(?:(?:file|link|workspace):|\.\.?[/\\])internal(?:[/\\]|(?=$|[\s"'`,)\]}]))/.test(
            line
          )) &&
        !isCopyBoundaryReference(relative, line)
      ) {
        findings.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  return findings;
}
