#!/usr/bin/env node
// Decides how much of the release rehearsal a CI run needs. macOS minutes bill
// at ten times the Linux rate, so an ordinary pull request compiles and smokes
// the release on Linux only: that still catches CLI behavior regressions, which
// fail on every leg alike. The macOS and ARM legs run where a platform-specific
// break is plausible — main, manual dispatch, a pull request that touches a
// packaging input, or one labeled `full-matrix`.
//
// Usage: node scripts/ci-gate.mjs
// Reads EVENT_NAME, PR_BASE_SHA and PR_LABELS (a JSON array of label names)
// from the environment and diffs PR_BASE_SHA against HEAD. Writes
// `full-matrix`, `compile-runner` and `smoke-matrix` to $GITHUB_OUTPUT.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  assertUsableSha,
  gitDiff,
  isAllZeroSha,
  isDependencyInput,
} from './dependency-files-changed.mjs';

export const FULL_MATRIX_LABEL = 'full-matrix';

// Everything the compile, staging and install-loop pipeline reads besides the
// built workspace output itself.
const PACKAGING_PATHS = new Set([
  '.bun-version',
  '.nvmrc',
  'apps/orcaops-watch/platforms.json',
  'apps/orcaops-watch/scripts/compile.ts',
  'scripts/build-cli-dist.mjs',
  'scripts/build-watch-platforms.mjs',
  'scripts/check-no-proprietary.mjs',
  'scripts/install-loop.mjs',
  'scripts/release-staging-pins.json',
  'scripts/third-party-notices.mjs',
]);
const PACKAGING_PREFIXES = ['scripts/lib/'];

const LINUX_SMOKE = [
  { os: 'ubuntu-latest', node: 22 },
  { os: 'ubuntu-latest', node: 24 },
];
const FULL_SMOKE = [
  ...LINUX_SMOKE,
  { os: 'macos-15', node: 22 },
  { os: 'macos-15', node: 24 },
  { os: 'ubuntu-24.04-arm', node: 22 },
  { os: 'macos-15-intel', node: 22 },
];

export function isPackagingInput(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    isDependencyInput(normalized) ||
    PACKAGING_PATHS.has(normalized) ||
    PACKAGING_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/**
 * @returns {{ fullMatrix: boolean, reason: string }}
 */
export function ciGate({ event, base, head, labels = [], runGitDiff }) {
  if (event !== 'pull_request') {
    return { fullMatrix: true, reason: `${event} runs the full release matrix` };
  }
  if (labels.includes(FULL_MATRIX_LABEL)) {
    return { fullMatrix: true, reason: `labeled ${FULL_MATRIX_LABEL}` };
  }
  // Without a usable range the safe answer is the full matrix, never a skip.
  if (!base || isAllZeroSha(base)) {
    return { fullMatrix: true, reason: 'no comparison base — running the full release matrix' };
  }
  assertUsableSha(base, 'base');
  assertUsableSha(head, 'head');

  const files = runGitDiff(base, head)
    .split('\0')
    .filter((f) => f.length > 0);
  const matched = files.filter(isPackagingInput);
  return matched.length > 0
    ? { fullMatrix: true, reason: `packaging inputs changed: ${matched.join(', ')}` }
    : {
        fullMatrix: false,
        reason: `no packaging inputs among ${files.length} changed file(s) — Linux-only release smoke`,
      };
}

export function gateOutputs(fullMatrix) {
  return {
    'full-matrix': String(fullMatrix),
    // Darwin executables are re-signed only on a Mac; the Linux legs never load them.
    'compile-runner': fullMatrix ? 'macos-15' : 'ubuntu-latest',
    'smoke-matrix': JSON.stringify({ include: fullMatrix ? FULL_SMOKE : LINUX_SMOKE }),
  };
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout.trim();
}

function main() {
  const event = process.env.EVENT_NAME ?? '';
  const base = process.env.PR_BASE_SHA ?? '';
  const labels = JSON.parse(process.env.PR_LABELS || '[]');
  // On pull_request the checked-out HEAD is the merge commit, so this diff is
  // exactly what merging would change.
  const head = git(['rev-parse', 'HEAD']);

  if (event === 'pull_request' && base && !isAllZeroSha(base)) {
    const present = spawnSync('git', ['cat-file', '-e', `${base}^{commit}`]).status === 0;
    if (!present) git(['fetch', '--no-tags', '--depth=1', 'origin', base]);
  }

  const { fullMatrix, reason } = ciGate({ event, base, head, labels, runGitDiff: gitDiff });
  const outputs = gateOutputs(fullMatrix);

  console.log(reason);
  for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
