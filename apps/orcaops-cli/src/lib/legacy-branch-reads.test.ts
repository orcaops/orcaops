import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BRANCH_SCOPED_CALL_PATTERNS = [
  /listArtifactsByLineageBranch\s*\(/u,
  /listArtifacts\s*\(\s*\{[^}]*\bbranch\b/u,
];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('branch-scoped artifact reads', () => {
  it('has no callers querying the legacy projection', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const text = await readFile(file, 'utf8');
      if (BRANCH_SCOPED_CALL_PATTERNS.some((pattern) => pattern.test(text))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognizes forbidden branch queries', () => {
    for (const source of [
      'store.listArtifactsByLineageBranch({ branch })',
      'store.listArtifacts({ branch: currentBranch })',
    ]) {
      expect(BRANCH_SCOPED_CALL_PATTERNS.some((pattern) => pattern.test(source))).toBe(true);
    }
  });
});
