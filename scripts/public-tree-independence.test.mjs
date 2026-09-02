import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkDependencyPolicy } from './check-dependency-policy.mjs';
import { copyPublicTree, findForbiddenInternalReferences } from './public-tree.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('public-tree independence', () => {
  it('copies a policy-complete public tree with no forbidden internal references', () => {
    const copyRoot = mkdtempSync(path.join(tmpdir(), 'orcaops-public-tree-'));
    try {
      const copied = copyPublicTree(repoRoot, copyRoot);
      expect(existsSync(path.join(copyRoot, 'internal'))).toBe(false);
      expect(existsSync(path.join(copyRoot, 'config', 'dependency-policy.json'))).toBe(true);
      expect(existsSync(path.join(copyRoot, 'docs', 'dependency-policy.md'))).toBe(true);
      expect(existsSync(path.join(copyRoot, 'apps', 'docs', 'content', 'index.md'))).toBe(true);
      expect(checkDependencyPolicy(copyRoot).errors).toEqual([]);
      expect(findForbiddenInternalReferences(copyRoot, copied)).toEqual([]);
    } finally {
      rmSync(copyRoot, { recursive: true, force: true });
    }
  });

  it.each(['internal' + '/', 'internal' + '\\adapter', 'file:' + 'internal', './' + 'internal'])(
    'rejects a forbidden internal reference written as %s',
    (reference) => {
      const copyRoot = mkdtempSync(path.join(tmpdir(), 'orcaops-public-reference-'));
      try {
        writeFileSync(path.join(copyRoot, 'reference.txt'), reference);
        expect(findForbiddenInternalReferences(copyRoot, ['reference.txt'])).toHaveLength(1);
      } finally {
        rmSync(copyRoot, { recursive: true, force: true });
      }
    }
  );

  it('rejects symlinks that escape the public tree', () => {
    const copyRoot = mkdtempSync(path.join(tmpdir(), 'orcaops-public-symlink-'));
    try {
      symlinkSync('/etc/hosts', path.join(copyRoot, 'external-link'));
      expect(findForbiddenInternalReferences(copyRoot, ['external-link'])).toEqual([
        'external-link: symlink target /etc/hosts resolves outside the public tree',
      ]);
    } finally {
      rmSync(copyRoot, { recursive: true, force: true });
    }
  });
});
