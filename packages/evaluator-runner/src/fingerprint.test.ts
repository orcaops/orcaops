import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ResolvedEvaluator } from '@orcaops/evaluator-protocol';

import {
  canonicalJson,
  clearExpandFingerprintIncludesCache,
  combineEvaluatorFingerprints,
  computeEvaluatorFingerprint,
  expandFingerprintIncludes,
} from './fingerprint.js';

function makeResolved(overrides: {
  ref?: string;
  package_root: string;
  spec_path: string;
  params?: Record<string, unknown>;
  severity?: 'info' | 'warn' | 'block';
  fingerprint_include?: string[];
}): ResolvedEvaluator {
  return {
    ref: overrides.ref ?? 'core/test',
    package_id: 'core',
    evaluator_id: 'test',
    package_root: overrides.package_root,
    spec_path: overrides.spec_path,
    phase: 'post-plan',
    severity: overrides.severity ?? 'info',
    description: 'fixture',
    engine: {
      kind: 'command',
      command: ['bash', 'x.sh'],
      cwd: 'package',
      timeout_ms: 1000,
      max_output_bytes: 1024,
      env: { inherit: [], set: {} },
    },
    params: overrides.params ?? {},
    filters: { paths: [], scopes: [], when_llm: 'optional' },
    resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
    fingerprint_include: overrides.fingerprint_include ?? [],
    enabled: true,
  };
}

describe('computeEvaluatorFingerprint', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeSpec(content: string): Promise<string> {
    const specDir = path.join(tmpRoot, 'evaluators');
    await mkdir(specDir, { recursive: true });
    const specPath = path.join(specDir, 'test.eval.yaml');
    await writeFile(specPath, content, 'utf8');
    return specPath;
  }

  it('produces a sha256 hex fingerprint and lists the spec as an input', async () => {
    const specPath = await writeSpec('spec contents v1');
    const { fingerprint, inputs, empty_patterns } = await computeEvaluatorFingerprint(
      makeResolved({ package_root: tmpRoot, spec_path: specPath })
    );
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(inputs).toEqual([specPath]);
    expect(empty_patterns).toEqual([]);
  });

  it('is stable across identical inputs', async () => {
    const specPath = await writeSpec('spec contents v1');
    const ev = makeResolved({ package_root: tmpRoot, spec_path: specPath });
    const a = await computeEvaluatorFingerprint(ev);
    const b = await computeEvaluatorFingerprint(ev);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('changes when spec content changes', async () => {
    const specPath = await writeSpec('spec contents v1');
    const ev = makeResolved({ package_root: tmpRoot, spec_path: specPath });
    const before = await computeEvaluatorFingerprint(ev);
    await writeFile(specPath, 'spec contents v2', 'utf8');
    const after = await computeEvaluatorFingerprint(ev);
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  it('changes when params change', async () => {
    const specPath = await writeSpec('spec');
    const a = await computeEvaluatorFingerprint(
      makeResolved({ package_root: tmpRoot, spec_path: specPath, params: { x: 1 } })
    );
    const b = await computeEvaluatorFingerprint(
      makeResolved({ package_root: tmpRoot, spec_path: specPath, params: { x: 2 } })
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('is insensitive to params key order (canonical JSON sorts keys)', async () => {
    const specPath = await writeSpec('spec');
    const a = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        params: { x: 1, y: 2 },
      })
    );
    const b = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        params: { y: 2, x: 1 },
      })
    );
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('changes when severity changes', async () => {
    const specPath = await writeSpec('spec');
    const a = await computeEvaluatorFingerprint(
      makeResolved({ package_root: tmpRoot, spec_path: specPath, severity: 'warn' })
    );
    const b = await computeEvaluatorFingerprint(
      makeResolved({ package_root: tmpRoot, spec_path: specPath, severity: 'block' })
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('includes files matched by fingerprint_include globs', async () => {
    const specPath = await writeSpec('spec');
    const libDir = path.join(tmpRoot, 'checks', 'lib');
    await mkdir(libDir, { recursive: true });
    const helperPath = path.join(libDir, 'helper.py');
    await writeFile(helperPath, 'def helper(): pass', 'utf8');
    const otherPath = path.join(libDir, 'other.py');
    await writeFile(otherPath, 'def other(): pass', 'utf8');

    const { fingerprint, inputs, empty_patterns } = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        fingerprint_include: ['./checks/lib/**/*.py'],
      })
    );
    expect(empty_patterns).toEqual([]);
    expect(inputs).toContain(helperPath);
    expect(inputs).toContain(otherPath);

    // Changing one of the matched files changes the fingerprint.
    await writeFile(helperPath, 'def helper(): return 42', 'utf8');
    const after = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        fingerprint_include: ['./checks/lib/**/*.py'],
      })
    );
    expect(after.fingerprint).not.toBe(fingerprint);
  });

  it('reports zero-match patterns in empty_patterns without erroring', async () => {
    const specPath = await writeSpec('spec');
    const { empty_patterns, inputs } = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        fingerprint_include: ['./checks/lib/**/*.py', './nonexistent/**/*.sh'],
      })
    );
    expect(empty_patterns).toContain('checks/lib/**/*.py');
    expect(empty_patterns).toContain('nonexistent/**/*.sh');
    expect(inputs).toEqual([specPath]); // no extra files
  });

  it('normalizes `./` and leading `/` in fingerprint_include patterns', async () => {
    const specPath = await writeSpec('spec');
    const checksDir = path.join(tmpRoot, 'checks');
    await mkdir(checksDir, { recursive: true });
    await writeFile(path.join(checksDir, 'foo.sh'), 'echo foo', 'utf8');

    const dotted = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        fingerprint_include: ['./checks/*.sh'],
      })
    );
    const unprefixed = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        fingerprint_include: ['checks/*.sh'],
      })
    );
    expect(dotted.fingerprint).toBe(unprefixed.fingerprint);
  });

  it('hashes a contained file reached through a matching symlink', async () => {
    const specPath = await writeSpec('spec');
    const checksDir = path.join(tmpRoot, 'checks');
    await mkdir(checksDir, { recursive: true });
    const target = path.join(checksDir, 'target.py');
    await writeFile(target, 'value = 1', 'utf8');
    await symlink(target, path.join(checksDir, 'linked.py'));

    const evaluator = makeResolved({
      package_root: tmpRoot,
      spec_path: specPath,
      fingerprint_include: ['checks/linked.py'],
    });
    const before = await computeEvaluatorFingerprint(evaluator);
    expect(before.inputs).toContain(await realpath(target));
    expect(before.empty_patterns).toEqual([]);

    await writeFile(target, 'value = 2', 'utf8');
    const after = await computeEvaluatorFingerprint(evaluator);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('follows a contained directory symlink only for a matching subtree', async () => {
    const specPath = await writeSpec('spec');
    const targetDir = path.join(tmpRoot, 'shared');
    await mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, 'helper.py');
    await writeFile(target, 'value = 1', 'utf8');
    await symlink(targetDir, path.join(tmpRoot, 'linked'));

    const result = await computeEvaluatorFingerprint(
      makeResolved({
        package_root: tmpRoot,
        spec_path: specPath,
        fingerprint_include: ['linked/**/*.py'],
      })
    );

    expect(result.inputs).toContain(await realpath(target));
    expect(result.empty_patterns).toEqual([]);
  });

  it('refuses a matching fingerprint symlink that resolves outside the pack', async () => {
    const specPath = await writeSpec('spec');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-outside-'));
    try {
      const outsideFile = path.join(outside, 'external.py');
      await writeFile(outsideFile, 'secret', 'utf8');
      const checksDir = path.join(tmpRoot, 'checks');
      await mkdir(checksDir, { recursive: true });
      await symlink(outsideFile, path.join(checksDir, 'external.py'));

      await expect(
        computeEvaluatorFingerprint(
          makeResolved({
            package_root: tmpRoot,
            spec_path: specPath,
            fingerprint_include: ['checks/**/*.py'],
          })
        )
      ).rejects.toThrow('resolves outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('skips incidental external symlinks but refuses the same symlink when named', async () => {
    const specPath = await writeSpec('spec');
    const runtimeDir = path.join(tmpRoot, 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const runtimeFile = path.join(runtimeDir, 'entry.mjs');
    await writeFile(runtimeFile, 'export default true;', 'utf8');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-dependency-'));
    try {
      await writeFile(path.join(outside, 'dependency.mjs'), 'external', 'utf8');
      await symlink(outside, path.join(tmpRoot, 'node_modules'));

      const result = await computeEvaluatorFingerprint(
        makeResolved({
          package_root: tmpRoot,
          spec_path: specPath,
          fingerprint_include: ['**/*.mjs'],
        })
      );

      expect(result.inputs).toContain(runtimeFile);
      expect(result.inputs).not.toContain(path.join(outside, 'dependency.mjs'));
      expect(result.empty_patterns).toEqual([]);

      const negated = await computeEvaluatorFingerprint(
        makeResolved({
          package_root: tmpRoot,
          spec_path: specPath,
          fingerprint_include: ['!(node_modules)/**/*.mjs'],
        })
      );

      expect(negated.inputs).toContain(runtimeFile);
      expect(negated.inputs).not.toContain(path.join(outside, 'dependency.mjs'));
      expect(negated.empty_patterns).toEqual([]);

      await expect(
        computeEvaluatorFingerprint(
          makeResolved({
            package_root: tmpRoot,
            spec_path: specPath,
            fingerprint_include: ['node_modules/**/*.mjs'],
          })
        )
      ).rejects.toThrow('resolves outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each([
    '{src/runtime,src/vendor}/**/*.mjs',
    '@(src/vendor)/**/*.mjs',
    '+(@(src|lib)/vendor)/**/*.mjs',
    'src/[v]endor/**/*.mjs',
    'src/{v..v}endor/**/*.mjs',
  ])('refuses an external directory symlink selected by %s', async (pattern) => {
    const specPath = await writeSpec('spec');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-alternative-'));
    try {
      await writeFile(path.join(outside, 'dependency.mjs'), 'external', 'utf8');
      await mkdir(path.join(tmpRoot, 'src'));
      await symlink(outside, path.join(tmpRoot, 'src', 'vendor'));

      await expect(
        computeEvaluatorFingerprint(
          makeResolved({
            package_root: tmpRoot,
            spec_path: specPath,
            fingerprint_include: [pattern],
          })
        )
      ).rejects.toThrow('resolves outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an external directory symlink needed to reach a named descendant', async () => {
    const specPath = await writeSpec('spec');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-named-descendant-'));
    try {
      await mkdir(path.join(outside, 'vendor'));
      await writeFile(path.join(outside, 'vendor', 'dependency.mjs'), 'external', 'utf8');
      await mkdir(path.join(tmpRoot, 'src'));
      await symlink(outside, path.join(tmpRoot, 'src', 'channel'));

      await expect(
        computeEvaluatorFingerprint(
          makeResolved({
            package_root: tmpRoot,
            spec_path: specPath,
            fingerprint_include: ['src/*/vendor/**/*.mjs'],
          })
        )
      ).rejects.toThrow('resolves outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an external directory symlink needed to reach a named final file', async () => {
    const specPath = await writeSpec('spec');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-named-file-'));
    try {
      await writeFile(path.join(outside, 'sensitive.mjs'), 'external', 'utf8');
      await mkdir(path.join(tmpRoot, 'src'));
      await symlink(outside, path.join(tmpRoot, 'src', 'channel'));

      await expect(
        computeEvaluatorFingerprint(
          makeResolved({
            package_root: tmpRoot,
            spec_path: specPath,
            fingerprint_include: ['src/*/sensitive.mjs'],
          })
        )
      ).rejects.toThrow('resolves outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an external directory symlink on the literal path to declared inputs', async () => {
    const specPath = await writeSpec('spec');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-declared-'));
    try {
      await writeFile(path.join(outside, 'dependency.mjs'), 'external', 'utf8');
      await symlink(outside, path.join(tmpRoot, 'linked'));

      await expect(
        computeEvaluatorFingerprint(
          makeResolved({
            package_root: tmpRoot,
            spec_path: specPath,
            fingerprint_include: ['linked/**/*.mjs'],
          })
        )
      ).rejects.toThrow('resolves outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('combineEvaluatorFingerprints', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-combine-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeSpec(name: string, content: string): Promise<string> {
    const dir = path.join(tmpRoot, 'evaluators');
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, `${name}.eval.yaml`);
    await writeFile(p, content, 'utf8');
    return p;
  }

  it('returns a sha256 hex string', async () => {
    const a = await writeSpec('a', 'spec a');
    const b = await writeSpec('b', 'spec b');
    const fp = await combineEvaluatorFingerprints([
      makeResolved({ ref: 'core/a', package_root: tmpRoot, spec_path: a }),
      makeResolved({ ref: 'core/b', package_root: tmpRoot, spec_path: b }),
    ]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is insensitive to evaluator order in the input array (sorted join)', async () => {
    const a = await writeSpec('a', 'spec a');
    const b = await writeSpec('b', 'spec b');
    const evA = makeResolved({ ref: 'core/a', package_root: tmpRoot, spec_path: a });
    const evB = makeResolved({ ref: 'core/b', package_root: tmpRoot, spec_path: b });
    const x = await combineEvaluatorFingerprints([evA, evB]);
    const y = await combineEvaluatorFingerprints([evB, evA]);
    expect(x).toBe(y);
  });

  it("changes when any single evaluator's fingerprint changes", async () => {
    const a = await writeSpec('a', 'spec a v1');
    const b = await writeSpec('b', 'spec b v1');
    const evA = makeResolved({ ref: 'core/a', package_root: tmpRoot, spec_path: a });
    const evB = makeResolved({ ref: 'core/b', package_root: tmpRoot, spec_path: b });
    const before = await combineEvaluatorFingerprints([evA, evB]);
    await writeFile(a, 'spec a v2', 'utf8');
    const after = await combineEvaluatorFingerprints([evA, evB]);
    expect(before).not.toBe(after);
  });

  it('returns a stable fingerprint for an empty set', async () => {
    const fp1 = await combineEvaluatorFingerprints([]);
    const fp2 = await combineEvaluatorFingerprints([]);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives, null, booleans', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(42)).toBe('42');
  });

  it('coerces NaN and Infinity to null', () => {
    expect(canonicalJson(NaN)).toBe('null');
    expect(canonicalJson(Infinity)).toBe('null');
  });
});

describe('glob-membership cache invalidation', () => {
  // The cache stores glob membership, so files added mid-process are not
  // visible until clearExpandFingerprintIncludesCache invalidates it.
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-clear-'));
    clearExpandFingerprintIncludesCache();
  });
  afterEach(async () => {
    clearExpandFingerprintIncludesCache();
    await rm(root, { recursive: true, force: true });
  });

  it('serves stale membership until cleared, fresh membership after', async () => {
    await writeFile(path.join(root, 'a.py'), 'a', 'utf8');
    const first = await expandFingerprintIncludes(root, ['*.py']);
    expect(first.matched).toEqual([path.join(root, 'a.py')]);

    // A matching file lands AFTER the cache was populated…
    await writeFile(path.join(root, 'b.py'), 'b', 'utf8');
    const stale = await expandFingerprintIncludes(root, ['*.py']);
    // …and the cached membership is served without it: the staleness the
    // seam exists to fix.
    expect(stale.matched).toEqual([path.join(root, 'a.py')]);

    clearExpandFingerprintIncludesCache();
    const fresh = await expandFingerprintIncludes(root, ['*.py']);
    expect(fresh.matched.sort()).toEqual([path.join(root, 'a.py'), path.join(root, 'b.py')]);
  });

  it('bypasses stale membership when a fresh expansion is required', async () => {
    await writeFile(path.join(root, 'a.py'), 'a', 'utf8');
    await expandFingerprintIncludes(root, ['*.py']);
    await writeFile(path.join(root, 'b.py'), 'b', 'utf8');

    const fresh = await expandFingerprintIncludes(root, ['*.py'], { fresh: true });

    expect(fresh.matched.sort()).toEqual([path.join(root, 'a.py'), path.join(root, 'b.py')]);
  });
});
