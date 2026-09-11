import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { filesWithLiteralNul, isSourcePath } from './check-source-nul.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('literal NUL source hygiene', () => {
  it('reports literal NUL bytes in tracked source candidates', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'orcaops-source-nul-'));
    temporaryDirectories.push(rootDir);
    writeFileSync(path.join(rootDir, 'clean.ts'), "const delimiter = '\\0';\n");
    writeFileSync(path.join(rootDir, 'bad.ts'), Buffer.from([0x61, 0x00, 0x62, 0x00]));
    mkdirSync(path.join(rootDir, 'dependencies'));
    symlinkSync('dependencies', path.join(rootDir, 'node_modules'));

    expect(
      filesWithLiteralNul(rootDir, ['clean.ts', 'bad.ts', 'deleted.ts', 'node_modules'])
    ).toEqual([{ filePath: 'bad.ts', count: 2 }]);
  });

  it('excludes binary archives and image assets while checking source and documentation', () => {
    expect(isSourcePath('vendor/package.tgz')).toBe(false);
    expect(isSourcePath('fixture/data.gz')).toBe(false);
    expect(isSourcePath('apps/docs/content/public/favicon.png')).toBe(false);
    expect(isSourcePath(['internal', 'implementation', 'original-output.txt'].join('/'))).toBe(
      false
    );
    expect(isSourcePath('src/module.ts')).toBe(true);
    expect(isSourcePath('README.md')).toBe(true);
  });
});
