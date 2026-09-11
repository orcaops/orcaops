#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BINARY_EXTENSIONS = new Set(['.gz', '.tgz', '.png']);

export function isSourcePath(filePath) {
  return (
    filePath.split('/')[0] !== 'internal' &&
    !BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}

export function filesWithLiteralNul(rootDir, filePaths) {
  return filePaths.filter(isSourcePath).flatMap((filePath) => {
    let bytes;
    try {
      const absolute = path.join(rootDir, filePath);
      if (!lstatSync(absolute).isFile()) return [];
      bytes = readFileSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const count = bytes.reduce((total, byte) => total + (byte === 0 ? 1 : 0), 0);
    return count === 0 ? [] : [{ filePath, count }];
  });
}

function trackedFiles(rootDir) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const matches = filesWithLiteralNul(rootDir, trackedFiles(rootDir));
  if (matches.length === 0) {
    console.log('Tracked public source files contain no literal NUL bytes.');
    return;
  }

  for (const { filePath, count } of matches) {
    console.error(`${filePath}: ${count} literal NUL byte(s)`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
