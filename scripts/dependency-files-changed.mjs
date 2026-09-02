#!/usr/bin/env node
// Decides whether a commit range touched anything that can change dependency
// resolution, so CI can skip the registry audit on unrelated pull requests
// while still ALWAYS reporting a status to the required check aggregator.
//
// Usage: node scripts/dependency-files-changed.mjs <base-sha> <head-sha>
// Writes `changed=true|false` to $GITHUB_OUTPUT when that variable is set.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const ALL_ZERO_PATTERN = /^0+$/;

const INPUT_BASENAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  'pnpmfile.cjs',
]);
const INPUT_DIRECTORIES = new Set(['patches', 'vendor']);
const INPUT_PATHS = new Set(['config/dependency-policy.json']);

/**
 * A directory match uses any path SEGMENT, not just a leading one: a nested
 * `packages/x/patches/` changes resolution exactly as a root `patches/` does.
 * Over-matching only costs one extra audit run; under-matching skips it.
 */
export function isDependencyInput(filePath) {
  if (filePath.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (INPUT_PATHS.has(normalized)) return true;

  const segments = normalized.split('/');
  if (INPUT_BASENAMES.has(segments[segments.length - 1])) return true;
  return segments.slice(0, -1).some((segment) => INPUT_DIRECTORIES.has(segment));
}

/** A branch-creation push has an all-zero base; there is no valid range to diff. */
export function isAllZeroSha(value) {
  return typeof value === 'string' && value.length >= 7 && ALL_ZERO_PATTERN.test(value);
}

export function assertUsableSha(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing ${label} commit. Pass the ${label} SHA as an argument.`);
  }
  if (!SHA_PATTERN.test(value)) {
    throw new Error(`Malformed ${label} commit "${value}". Expected a 7-40 character hex SHA.`);
  }
}

/**
 * @returns {{ changed: boolean, reason: string, files?: string[] }}
 */
export function dependencyFilesChanged({ base, head, runGitDiff }) {
  // Branch creation: audit unconditionally rather than diffing against nothing
  // or, worse, reporting the branch as unchanged.
  if (isAllZeroSha(base)) {
    return {
      changed: true,
      reason: 'all-zero base SHA (branch creation) — auditing unconditionally',
    };
  }
  assertUsableSha(base, 'base');
  assertUsableSha(head, 'head');

  const output = runGitDiff(base, head);
  // NUL-delimited so filenames containing spaces, quotes, or newlines survive
  // intact; git would otherwise quote and escape them in its default output.
  const files = output.split('\0').filter((f) => f.length > 0);
  const matched = files.filter(isDependencyInput);

  return matched.length > 0
    ? { changed: true, reason: `dependency inputs changed: ${matched.join(', ')}`, files: matched }
    : {
        changed: false,
        reason: `no dependency inputs among ${files.length} changed file(s)`,
        files: [],
      };
}

function gitDiff(base, head) {
  const result = spawnSync('git', ['diff', '--name-only', '-z', `${base}`, `${head}`], {
    encoding: 'utf8',
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git diff ${base} ${head} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function main() {
  const [base, head] = process.argv.slice(2);
  const { changed, reason } = dependencyFilesChanged({ base, head, runGitDiff: gitDiff });

  console.log(reason);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
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
