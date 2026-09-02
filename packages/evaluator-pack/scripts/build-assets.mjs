#!/usr/bin/env node
/**
 * Copy every non-TS pack asset from packs/<id>/ into dist/packs/<id>/.
 * Runs after `tsc -p tsconfig.dist.json` compiles the runtime sources,
 * producing a self-contained dist/packs/<id>/ tree that is the
 * canonical pack root the runner's resolver expects.
 *
 * Assets covered:
 *   - package.yaml
 *   - evaluators/*.eval.yaml
 *   - prompts/**
 *   - fixtures/**
 *
 * Anything else under packs/<id>/ (TS sources, test files) is left
 * uncopied; tsc handles the runtime/*.ts compilation directly.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packsSrc = path.join(packageRoot, 'packs');
const packsDist = path.join(packageRoot, 'dist', 'packs');

const COPY_DIRS = ['evaluators', 'prompts', 'fixtures'];
const COPY_FILES = ['package.yaml'];

async function listPacks() {
  const entries = await readdir(packsSrc, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function copyDirRecursive(src, dst) {
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  await mkdir(dst, { recursive: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += await copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, dstPath);
      count += 1;
    }
  }
  return count;
}

async function copyFileIfExists(src, dst) {
  try {
    await stat(src);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile(src, dst);
  return 1;
}

async function main() {
  const packs = await listPacks();
  let copied = 0;
  for (const packId of packs) {
    const srcPack = path.join(packsSrc, packId);
    const dstPack = path.join(packsDist, packId);
    for (const file of COPY_FILES) {
      copied += await copyFileIfExists(path.join(srcPack, file), path.join(dstPack, file));
    }
    for (const dir of COPY_DIRS) {
      copied += await copyDirRecursive(path.join(srcPack, dir), path.join(dstPack, dir));
    }
  }
  console.log(`Copied ${copied} pack asset file(s) into dist/packs/.`);
}

void main().catch((err) => {
  console.error('build-assets failed:', err);
  process.exit(1);
});
