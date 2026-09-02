import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EvaluatorDiscoveryError } from './errors.js';
import { resolvePackSource } from './resolver.js';

/**
 * resolvePackSource handles the three pack-source kinds the config
 * schema accepts. The tests use throwaway temp dirs to
 * simulate the user repo, the CLI install, and a fake "installed
 * dependency" so they don't depend on the workspace layout.
 */
describe('resolvePackSource', () => {
  let scratch: string;

  beforeEach(async () => {
    // realpathSync normalizes macOS /var → /private/var; require.resolve
    // does the same internally so the test's expected paths must match.
    scratch = realpathSync(await mkdtemp(path.join(tmpdir(), 'orcaops-resolver-test-')));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  describe('kind: path', () => {
    it('resolves a relative path against repoRoot', () => {
      const result = resolvePackSource(
        { kind: 'path', path: './my-packs/security' },
        { repoRoot: '/users/foo/proj' }
      );
      expect(result.pack_root).toBe(path.resolve('/users/foo/proj', './my-packs/security'));
      expect(result.source).toEqual({ kind: 'path', path: './my-packs/security' });
    });

    it('honors an absolute path verbatim', () => {
      const abs = path.join(scratch, 'absolute-pack');
      const result = resolvePackSource(
        { kind: 'path', path: abs },
        { repoRoot: '/some/other/place' }
      );
      expect(result.pack_root).toBe(abs);
    });
  });

  describe('kind: package', () => {
    it('throws EvaluatorDiscoveryError with a pnpm-add hint when the package is missing', () => {
      // No node_modules in scratch → resolution fails.
      expect(() =>
        resolvePackSource(
          { kind: 'package', package: '@nonexistent/orcaops-pack', pack: 'security' },
          { repoRoot: scratch }
        )
      ).toThrow(EvaluatorDiscoveryError);
    });

    it('error message names the missing package and suggests the install command', () => {
      try {
        resolvePackSource(
          { kind: 'package', package: '@acme/orcaops-pack', pack: 'security' },
          { repoRoot: scratch }
        );
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(EvaluatorDiscoveryError);
        const message = (err as EvaluatorDiscoveryError).message;
        expect(message).toContain('@acme/orcaops-pack');
        expect(message).toContain('pnpm add -D @acme/orcaops-pack');
      }
    });

    it('resolves a package installed under repoRoot/node_modules', async () => {
      // Synthesize a fake installed package at scratch/node_modules/<pkg>.
      const fakeRoot = path.join(scratch, 'node_modules', 'fake-orcaops-pack');
      const distPackRoot = path.join(fakeRoot, 'dist', 'packs', 'security');
      await mkdir(distPackRoot, { recursive: true });
      await writeFile(
        path.join(fakeRoot, 'package.json'),
        JSON.stringify({ name: 'fake-orcaops-pack', version: '0.0.0' }),
        'utf8'
      );
      // package.yaml at the dist pack root — resolver prefers dist when
      // the file exists.
      await writeFile(
        path.join(distPackRoot, 'package.yaml'),
        'schema: orcaops.evaluator_package/v1\nid: security\n',
        'utf8'
      );

      const result = resolvePackSource(
        { kind: 'package', package: 'fake-orcaops-pack', pack: 'security' },
        { repoRoot: scratch }
      );
      expect(result.pack_root).toBe(distPackRoot);
    });

    it('falls back to packs/<id> when dist/packs/<id>/package.yaml is absent', async () => {
      const fakeRoot = path.join(scratch, 'node_modules', 'workspace-pack');
      const sourcePackRoot = path.join(fakeRoot, 'packs', 'security');
      await mkdir(sourcePackRoot, { recursive: true });
      await writeFile(
        path.join(fakeRoot, 'package.json'),
        JSON.stringify({ name: 'workspace-pack', version: '0.0.0' }),
        'utf8'
      );
      // No package.yaml at dist; resolver should commit to the source
      // path (loadPackage will fail later, but the resolver's job is
      // to pick a path).

      const result = resolvePackSource(
        { kind: 'package', package: 'workspace-pack', pack: 'security' },
        { repoRoot: scratch }
      );
      expect(result.pack_root).toBe(sourcePackRoot);
    });
  });

  describe('kind: bundled', () => {
    it('throws when the bundled package is missing from the CLI root', () => {
      // cliRoot points at a directory with no node_modules.
      expect(() =>
        resolvePackSource(
          { kind: 'bundled', package: '@nonexistent/evaluator-pack', pack: 'core' },
          { repoRoot: scratch, cliRoot: scratch }
        )
      ).toThrow(EvaluatorDiscoveryError);
    });

    it('error message mentions the CLI install path', () => {
      try {
        resolvePackSource(
          { kind: 'bundled', package: '@nowhere/evaluator-pack', pack: 'core' },
          { repoRoot: '/repo', cliRoot: scratch }
        );
        expect.fail('expected throw');
      } catch (err) {
        const message = (err as EvaluatorDiscoveryError).message;
        expect(message).toContain('@nowhere/evaluator-pack');
        expect(message).toContain(scratch);
        expect(message).toContain('first-party packs ship as a workspace dep');
      }
    });

    it('resolves a bundled package found in cliRoot/node_modules', async () => {
      const fakeRoot = path.join(scratch, 'node_modules', 'fake-bundled');
      const distPackRoot = path.join(fakeRoot, 'dist', 'packs', 'core');
      await mkdir(distPackRoot, { recursive: true });
      await writeFile(
        path.join(fakeRoot, 'package.json'),
        JSON.stringify({ name: 'fake-bundled', version: '0.0.0' }),
        'utf8'
      );
      await writeFile(
        path.join(distPackRoot, 'package.yaml'),
        'schema: orcaops.evaluator_package/v1\nid: core\n',
        'utf8'
      );

      const result = resolvePackSource(
        { kind: 'bundled', package: 'fake-bundled', pack: 'core' },
        { repoRoot: '/elsewhere', cliRoot: scratch }
      );
      expect(result.pack_root).toBe(distPackRoot);
    });
  });
});
