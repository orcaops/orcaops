import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStore } from '@orcaops/core';

import {
  computePackTrustDecisions,
  grantsFilePath,
  readGrants,
  readTrustManifest,
  revokeGrant,
  trustManifestCovers,
  writeGrant,
} from './evaluator-grants.js';
import { TEST_PACK_ABS_PATH } from '../../tests/support/test-helpers.js';
import { ErrorCodes } from '../io/errors.js';

let configDir: string;
let tmpRoot: string;
let packPath: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'orcaops-grants-'));
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-grants-pack-'));
  packPath = path.join(tmpRoot, 'test-pack');
  await cp(TEST_PACK_ABS_PATH, packPath, { recursive: true });
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
});

const GRANT = {
  kind: 'fingerprint' as const,
  package_id: 'test-pack',
  source_fingerprint: 'a'.repeat(64),
  capabilities: ['command_evaluators_present' as const],
  granted_at: '2026-01-01T00:00:00.000Z',
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`child exited with code ${child.exitCode}`));
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

describe('grants file', () => {
  it('reads empty when absent and round-trips a grant', async () => {
    expect(readGrants({ configDir, repoRoot: tmpRoot }).grants).toEqual([]);
    await writeGrant(GRANT, { configDir, repoRoot: tmpRoot });
    expect(readGrants({ configDir, repoRoot: tmpRoot }).grants).toEqual([GRANT]);
  });

  it('replaces the prior grant for the same package', async () => {
    await writeGrant(GRANT, { configDir, repoRoot: tmpRoot });
    await writeGrant(
      { ...GRANT, source_fingerprint: 'b'.repeat(64) },
      { configDir, repoRoot: tmpRoot }
    );
    const { grants } = readGrants({ configDir, repoRoot: tmpRoot });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ source_fingerprint: 'b'.repeat(64) });
  });

  it('revoke removes only the named package', async () => {
    await writeGrant(GRANT, { configDir, repoRoot: tmpRoot });
    await writeGrant({ ...GRANT, package_id: 'other' }, { configDir, repoRoot: tmpRoot });
    await expect(revokeGrant('test-pack', { configDir, repoRoot: tmpRoot })).resolves.toBe(true);
    expect(readGrants({ configDir, repoRoot: tmpRoot }).grants.map((g) => g.package_id)).toEqual([
      'other',
    ]);
    await expect(revokeGrant('test-pack', { configDir, repoRoot: tmpRoot })).resolves.toBe(false);
  });

  it('a malformed grants file is fail-closed empty with a warning', async () => {
    await writeFile(grantsFilePath(configDir), '{not json', 'utf8');
    const warnings: string[] = [];
    expect(
      readGrants({ configDir, repoRoot: tmpRoot, warn: (m) => warnings.push(m) }).grants
    ).toEqual([]);
    expect(warnings[0]).toMatch(/fail closed/);
    await writeFile(
      grantsFilePath(configDir),
      JSON.stringify({ v: 1, grants: [{ kind: 'mystery' }] }),
      'utf8'
    );
    expect(
      readGrants({ configDir, repoRoot: tmpRoot, warn: (m) => warnings.push(m) }).grants
    ).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked grants file instead of following it',
    async () => {
      const target = path.join(tmpRoot, 'planted-grants.json');
      await writeFile(target, `${JSON.stringify({ v: 1, grants: [GRANT] })}\n`, {
        mode: 0o600,
      });
      await symlink(target, grantsFilePath(configDir));

      const warnings: string[] = [];
      expect(
        readGrants({
          configDir,
          repoRoot: tmpRoot,
          warn: (message) => warnings.push(message),
        }).grants
      ).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('unsafe ownership or permissions');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'repairs widened grant state on read and replaces it privately',
    async () => {
      await writeGrant(GRANT, { configDir, repoRoot: tmpRoot });
      chmodSync(configDir, 0o777);
      chmodSync(grantsFilePath(configDir), 0o666);

      expect(readGrants({ configDir, repoRoot: tmpRoot }).grants).toEqual([GRANT]);
      expect(statSync(configDir).mode & 0o077).toBe(0);
      expect(statSync(grantsFilePath(configDir)).mode & 0o077).toBe(0);

      await writeGrant(
        { ...GRANT, source_fingerprint: 'b'.repeat(64) },
        { configDir, repoRoot: tmpRoot }
      );
      expect(statSync(grantsFilePath(configDir)).mode & 0o777).toBe(0o600);
      expect(readdirSync(configDir).filter((entry) => entry.includes('.tmp.'))).toEqual([]);
    }
  );

  it('serializes a grant mutation behind the config store lock in another process', async () => {
    const coreDist = path.join(REPO_ROOT, 'packages/core/dist/index.js');
    const grantsDist = path.join(REPO_ROOT, 'apps/orcaops-cli/dist/lib/evaluator-grants.js');
    expect(existsSync(coreDist), 'build @orcaops/core before this cross-process proof').toBe(true);
    expect(existsSync(grantsDist), 'build @orcaops/cli before this cross-process proof').toBe(true);

    const ready = path.join(configDir, 'holder-ready');
    const release = path.join(configDir, 'holder-release');
    const writerReady = path.join(configDir, 'writer-ready');
    const done = path.join(configDir, 'writer-done');
    const holderScript = path.join(tmpRoot, 'grant-lock-holder.mjs');
    const writerScript = path.join(tmpRoot, 'grant-lock-writer.mjs');
    await writeFile(
      holderScript,
      [
        'const [coreDist, configDir, ready, release] = process.argv.slice(2);',
        'const { FileStore } = await import(coreDist);',
        'const { existsSync, writeFileSync } = await import("node:fs");',
        'const store = new FileStore({ dir: configDir });',
        'await store.withRefreshLock("holder", async () => {',
        '  writeFileSync(ready, "ready");',
        '  while (!existsSync(release)) await new Promise((r) => setTimeout(r, 10));',
        '});',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      writerScript,
      [
        'const [grantsDist, configDir, repoRoot, ready, done] = process.argv.slice(2);',
        'const { writeFileSync } = await import("node:fs");',
        'const { writeGrant } = await import(grantsDist);',
        'writeFileSync(ready, "ready");',
        `const grant = ${JSON.stringify({ ...GRANT, package_id: 'cross-process' })};`,
        'await writeGrant(grant, { configDir, repoRoot });',
        'writeFileSync(done, "done");',
      ].join('\n'),
      'utf8'
    );

    const holder = spawn(process.execPath, [holderScript, coreDist, configDir, ready, release]);
    let writer: ChildProcess | undefined;
    try {
      await waitForFile(ready);
      writer = spawn(process.execPath, [
        writerScript,
        grantsDist,
        configDir,
        tmpRoot,
        writerReady,
        done,
      ]);
      await waitForFile(writerReady);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(done)).toBe(false);
      await writeFile(release, 'release', 'utf8');
      await Promise.all([waitForChild(holder), waitForChild(writer)]);
      expect(existsSync(done)).toBe(true);
      expect(
        readGrants({ configDir, repoRoot: tmpRoot }).grants.map((grant) => grant.package_id)
      ).toContain('cross-process');
    } finally {
      if (!existsSync(release)) await writeFile(release, 'release', 'utf8');
      if (holder.exitCode === null) holder.kill();
      if (writer?.exitCode === null) writer.kill();
    }
  });
});

describe('installation trust manifest', () => {
  async function writeManifest(cliRoot: string, body: unknown): Promise<void> {
    await mkdir(path.join(cliRoot, 'dist'), { recursive: true });
    await writeFile(
      path.join(cliRoot, 'dist', 'trust-manifest.json'),
      JSON.stringify(body),
      'utf8'
    );
  }

  it('absent or malformed manifests are fail-closed null', async () => {
    const cliRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cliroot-'));
    try {
      expect(readTrustManifest(cliRoot)).toBeNull();
      await writeManifest(cliRoot, { v: 99, packs: 'nope' });
      expect(readTrustManifest(cliRoot)).toBeNull();
      await writeManifest(cliRoot, {
        v: 1,
        packs: [
          {
            package: '@orcaops/evaluator-pack',
            pack: 'core',
            version: '0.0.1',
            source_fingerprint: 'f'.repeat(64),
            capabilities: [],
          },
        ],
      });
      expect(readTrustManifest(cliRoot)).toBeNull();
      await writeFile(path.join(cliRoot, 'dist', 'trust-manifest.json'), '{oops', 'utf8');
      expect(readTrustManifest(cliRoot)).toBeNull();
    } finally {
      await rm(cliRoot, { recursive: true, force: true });
    }
  });

  it('a mismatched manifest fingerprint fails closed at the decision', async () => {
    // A path-source pack never matches the manifest tier (bundled-only), and
    // with no grant the decision is refused — the manifest cannot be a
    // side-door for non-bundled sources even with a "correct-looking" entry.
    const cliRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cliroot-'));
    try {
      await writeManifest(cliRoot, {
        v: 1,
        packs: [
          {
            package: '@orcaops/evaluator-pack',
            pack: 'test-pack',
            source_fingerprint: 'f'.repeat(64),
            capabilities: ['command_evaluators_present'],
          },
        ],
      });
      const decisions = await computePackTrustDecisions({
        packs: [
          {
            packageId: 'test-pack',
            source: { kind: 'path', path: packPath },
          },
        ],
        repoRoot: tmpRoot,
        cliRoot,
        configDir,
      });
      const decision = decisions.get('test-pack');
      expect(decision?.verdict).toBe('refused');
    } finally {
      await rm(cliRoot, { recursive: true, force: true });
    }
  });

  it('a changed covered runtime file breaks a fingerprint grant', async () => {
    // Grant against the current covered pack files via the real decision path first.
    const cliRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cliroot-'));
    try {
      const { computePackSourceFingerprint, resolvePackSource } =
        await import('@orcaops/evaluator-runner');
      const resolved = resolvePackSource(
        { kind: 'path', path: packPath },
        { repoRoot: tmpRoot, cliRoot }
      );
      const { fingerprint } = await computePackSourceFingerprint(resolved);
      await writeGrant(
        { ...GRANT, source_fingerprint: fingerprint },
        { configDir, repoRoot: tmpRoot }
      );
      const before = await computePackTrustDecisions({
        packs: [
          {
            packageId: 'test-pack',
            source: { kind: 'path', path: packPath },
          },
        ],
        repoRoot: tmpRoot,
        cliRoot,
        configDir,
      });
      expect(before.get('test-pack')?.verdict).toBe('trusted');

      // Change one declared command file: the same grant must now refuse.
      const runtimeFile = path.join(packPath, 'runtime', 'pass-fixture.mjs');
      await writeFile(runtimeFile, (await readFile(runtimeFile, 'utf8')) + '//x\n', 'utf8');
      const after = await computePackTrustDecisions({
        packs: [
          {
            packageId: 'test-pack',
            source: { kind: 'path', path: packPath },
          },
        ],
        repoRoot: tmpRoot,
        cliRoot,
        configDir,
      });
      expect(after.get('test-pack')?.verdict).toBe('refused');
    } finally {
      await rm(cliRoot, { recursive: true, force: true });
    }
  });

  it('coverage requires the source identity and every requested capability', async () => {
    const cliRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cliroot-'));
    try {
      const fingerprint = 'f'.repeat(64);
      await writeManifest(cliRoot, {
        v: 1,
        packs: [
          {
            package: '@orcaops/evaluator-pack',
            pack: 'actual-pack',
            source_fingerprint: fingerprint,
            capabilities: ['llm_evaluators_present'],
          },
        ],
      });
      const manifest = readTrustManifest(cliRoot);
      const source = {
        kind: 'bundled' as const,
        package: '@orcaops/evaluator-pack',
        pack: 'actual-pack',
      };

      expect(trustManifestCovers(manifest, source, fingerprint, ['llm_evaluators_present'])).toBe(
        true
      );
      expect(
        trustManifestCovers(manifest, { ...source, pack: 'config-id-override' }, fingerprint, [
          'llm_evaluators_present',
        ])
      ).toBe(false);
      expect(
        trustManifestCovers(manifest, source, fingerprint, [
          'llm_evaluators_present',
          'file_reading_llm_evaluator_present',
        ])
      ).toBe(false);
    } finally {
      await rm(cliRoot, { recursive: true, force: true });
    }
  });

  it('combines a matching manifest entry with a matching user grant', async () => {
    const cliRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cliroot-'));
    try {
      const packageRoot = path.join(cliRoot, 'node_modules', 'fake-bundled');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'fake-bundled', version: '0.0.1' }),
        'utf8'
      );
      await cp(packPath, path.join(packageRoot, 'packs', 'core'), { recursive: true });
      const source = {
        kind: 'bundled' as const,
        package: 'fake-bundled',
        pack: 'core',
      };
      const { computePackSourceFingerprint, resolvePackSource } =
        await import('@orcaops/evaluator-runner');
      const resolved = resolvePackSource(source, { repoRoot: tmpRoot, cliRoot });
      const { fingerprint } = await computePackSourceFingerprint(resolved);
      await writeManifest(cliRoot, {
        v: 1,
        packs: [
          {
            package: source.package,
            pack: source.pack,
            source_fingerprint: fingerprint,
            capabilities: ['command_evaluators_present'],
          },
        ],
      });
      await writeGrant(
        {
          kind: 'fingerprint',
          package_id: 'test-pack',
          source_fingerprint: fingerprint,
          capabilities: ['llm_evaluators_present', 'file_reading_llm_evaluator_present'],
          granted_at: '2026-01-01T00:00:00.000Z',
        },
        { configDir, repoRoot: tmpRoot }
      );

      const decisions = await computePackTrustDecisions({
        packs: [
          {
            packageId: 'test-pack',
            source,
          },
        ],
        repoRoot: tmpRoot,
        cliRoot,
        configDir,
      });

      expect(decisions.get('test-pack')).toEqual({
        verdict: 'trusted',
        capabilities: [
          'command_evaluators_present',
          'llm_evaluators_present',
          'file_reading_llm_evaluator_present',
        ],
      });
    } finally {
      await rm(cliRoot, { recursive: true, force: true });
    }
  });
});

describe('grant-store containment (repo-controlled config home)', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses invalid repository roots before touching the store',
    async () => {
      await writeFile(grantsFilePath(configDir), `${JSON.stringify({ v: 1, grants: [GRANT] })}\n`, {
        mode: 0o644,
      });
      const rootFile = path.join(tmpRoot, 'root-file');
      await writeFile(rootFile, 'not a directory', 'utf8');
      for (const repoRoot of [
        '',
        'relative-repo-root',
        path.join(tmpRoot, 'missing-repo'),
        rootFile,
      ]) {
        chmodSync(configDir, 0o755);
        const warnings: string[] = [];

        expect(
          readGrants({
            configDir,
            repoRoot,
            warn: (message) => warnings.push(message),
          }).grants
        ).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/repository root/);
        expect(statSync(configDir).mode & 0o777).toBe(0o755);
        await expect(writeGrant(GRANT, { configDir, repoRoot })).rejects.toMatchObject({
          code: ErrorCodes.INVALID_INPUT,
          message: expect.stringMatching(/repository root/),
        });
        await expect(revokeGrant(GRANT.package_id, { configDir, repoRoot })).rejects.toMatchObject({
          code: ErrorCodes.INVALID_INPUT,
          message: expect.stringMatching(/repository root/),
        });
        expect(statSync(configDir).mode & 0o777).toBe(0o755);
      }
    }
  );

  it('a repo-contained grants store supplies NO grants (fail closed, warned)', async () => {
    // The hostile shape: ORCAOPS_CONFIG_HOME pointing INSIDE the repository
    // at a checked-in, correctly-fingerprinted grants file.
    const repoRoot = tmpRoot;
    const insideDir = path.join(repoRoot, '.orcaops-fake-home');
    const { computePackSourceFingerprint, resolvePackSource } =
      await import('@orcaops/evaluator-runner');
    const resolved = resolvePackSource(
      { kind: 'path', path: packPath },
      { repoRoot, cliRoot: repoRoot }
    );
    const { fingerprint } = await computePackSourceFingerprint(resolved);
    await expect(
      writeGrant({ ...GRANT, source_fingerprint: fingerprint }, { configDir: insideDir, repoRoot })
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringMatching(/outside the repository/),
    });
    await expect(
      revokeGrant('test-pack', { configDir: insideDir, repoRoot })
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringMatching(/outside the repository/),
    });
    await mkdir(insideDir, { recursive: true, mode: 0o700 });
    await writeFile(
      grantsFilePath(insideDir),
      `${JSON.stringify({ v: 1, grants: [{ ...GRANT, source_fingerprint: fingerprint }] })}\n`,
      { mode: 0o600 }
    );
    if (process.platform !== 'win32') {
      chmodSync(insideDir, 0o755);
      chmodSync(grantsFilePath(insideDir), 0o644);
    }

    const readWarnings: string[] = [];
    expect(
      readGrants({
        configDir: insideDir,
        repoRoot,
        warn: (message) => readWarnings.push(message),
      }).grants
    ).toEqual([]);
    expect(readWarnings.some((warning) => warning.includes('outside the repository'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(insideDir).mode & 0o777).toBe(0o755);
      expect(statSync(grantsFilePath(insideDir)).mode & 0o777).toBe(0o644);
    }

    const warnings: string[] = [];
    const decisions = await computePackTrustDecisions({
      packs: [
        {
          packageId: 'test-pack',
          source: { kind: 'path', path: packPath },
        },
      ],
      repoRoot,
      cliRoot: repoRoot,
      configDir: insideDir,
      warn: (m) => warnings.push(m),
    });
    expect(decisions.get('test-pack')?.verdict).toBe('refused');
    expect(warnings.some((w) => w.includes('outside the repository'))).toBe(true);
  });

  it('a relative config home is refused the same way', async () => {
    const warnings: string[] = [];
    const decisions = await computePackTrustDecisions({
      packs: [
        {
          packageId: 'test-pack',
          source: { kind: 'path', path: packPath },
        },
      ],
      repoRoot: tmpRoot,
      cliRoot: tmpRoot,
      configDir: '.orcaops',
      warn: (m) => warnings.push(m),
    });
    expect(decisions.get('test-pack')?.verdict).toBe('refused');
    expect(warnings.some((w) => w.includes('outside the repository'))).toBe(true);
  });
});

describe('workspace-dev tier is path-source-only', () => {
  it('a dev grant authorizes its own path source (control)', async () => {
    await writeGrant(
      {
        kind: 'workspace-dev',
        package_id: 'test-pack',
        resolved_path: packPath,
        capabilities: ['command_evaluators_present'],
        granted_at: '2026-01-01T00:00:00.000Z',
      },
      { configDir, repoRoot: tmpRoot }
    );
    const decisions = await computePackTrustDecisions({
      packs: [
        {
          packageId: 'test-pack',
          source: { kind: 'path', path: packPath },
        },
      ],
      repoRoot: tmpRoot,
      cliRoot: tmpRoot,
      configDir,
    });
    expect(decisions.get('test-pack')?.verdict).toBe('trusted');
  });

  it('the SAME grant does not authorize a bundled source resolving to the same bytes', async () => {
    // Resolution must SUCCEED here or the test would pass for the wrong
    // reason (the reviewer's point): a bundled source anchored at a cliRoot
    // that really contains the pack resolves fine, so the only thing that can
    // refuse it is the path-source restriction on the dev tier.
    const cliRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cliroot-'));
    try {
      const bundledDir = path.join(cliRoot, 'node_modules', '@orcaops', 'evaluator-pack');
      await mkdir(path.join(bundledDir, 'packs'), { recursive: true });
      await cp(packPath, path.join(bundledDir, 'packs', 'test-pack'), { recursive: true });
      await writeFile(
        path.join(bundledDir, 'package.json'),
        JSON.stringify({ name: '@orcaops/evaluator-pack', version: '0.0.1' }),
        'utf8'
      );
      const source = {
        kind: 'bundled' as const,
        package: '@orcaops/evaluator-pack',
        pack: 'test-pack',
      };
      const { resolvePackSource } = await import('@orcaops/evaluator-runner');
      const resolvedRoot = resolvePackSource(source, { repoRoot: tmpRoot, cliRoot }).pack_root;
      // Grant the dev tier against the resolved bundled path itself — the
      // strongest form of the attack.
      await writeGrant(
        {
          kind: 'workspace-dev',
          package_id: 'test-pack',
          resolved_path: resolvedRoot,
          capabilities: ['command_evaluators_present'],
          granted_at: '2026-01-01T00:00:00.000Z',
        },
        { configDir, repoRoot: tmpRoot }
      );
      const decisions = await computePackTrustDecisions({
        packs: [{ packageId: 'test-pack', source }],
        repoRoot: tmpRoot,
        cliRoot,
        configDir,
      });
      expect(decisions.get('test-pack')?.verdict).toBe('refused');
    } finally {
      await rm(cliRoot, { recursive: true, force: true });
    }
  });
});

describe('grant-store containment resolves symlinks', () => {
  it('accepts an external store symlink and operates on its canonical target', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-repo-'));
    const externalStore = await mkdtemp(path.join(tmpdir(), 'orcaops-store-'));
    const linkParent = await mkdtemp(path.join(tmpdir(), 'orcaops-link-'));
    const linked = path.join(linkParent, 'alias');
    try {
      await symlink(externalStore, linked);
      await writeGrant(GRANT, { configDir: linked, repoRoot });
      await rm(linked);

      expect(readGrants({ configDir: externalStore, repoRoot }).grants).toEqual([GRANT]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(externalStore, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  it('keeps using the canonical store when the accepted alias is swapped', async () => {
    let repoRoot: string | undefined;
    let externalStore: string | undefined;
    let linkParent: string | undefined;
    try {
      repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-repo-'));
      externalStore = await mkdtemp(path.join(tmpdir(), 'orcaops-store-'));
      linkParent = await mkdtemp(path.join(tmpdir(), 'orcaops-link-'));
      const repoStore = path.join(repoRoot, '.repo-store');
      const linked = path.join(linkParent, 'alias');
      await mkdir(repoStore);
      await symlink(externalStore, linked);
      const lockSpy = vi
        .spyOn(FileStore.prototype, 'withRefreshLock')
        .mockImplementation(async (_baseUrl, callback) => {
          await rm(linked);
          await symlink(repoStore, linked);
          return callback();
        });
      try {
        await writeGrant(GRANT, { configDir: linked, repoRoot });

        expect(lockSpy).toHaveBeenCalledTimes(1);
        expect(readGrants({ configDir: externalStore, repoRoot }).grants).toEqual([GRANT]);
        expect(existsSync(grantsFilePath(repoStore))).toBe(false);
      } finally {
        lockSpy.mockRestore();
      }
    } finally {
      if (repoRoot !== undefined) await rm(repoRoot, { recursive: true, force: true });
      if (externalStore !== undefined) await rm(externalStore, { recursive: true, force: true });
      if (linkParent !== undefined) await rm(linkParent, { recursive: true, force: true });
    }
  });

  it('a symlinked spelling of a repo-contained store is still refused', async () => {
    // Lexical prefix comparison would accept this: the symlink path does not
    // start with repoRoot, but it RESOLVES inside it.
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-repo-'));
    const linkParent = await mkdtemp(path.join(tmpdir(), 'orcaops-link-'));
    try {
      const realStore = path.join(repoRoot, '.orcaops-store');
      await mkdir(realStore, { recursive: true });
      const linked = path.join(linkParent, 'alias');
      await symlink(realStore, linked);
      await expect(
        writeGrant(
          { ...GRANT, source_fingerprint: 'f'.repeat(64) },
          { configDir: linked, repoRoot }
        )
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_INPUT,
        message: expect.stringMatching(/outside the repository/),
      });
      await expect(revokeGrant('test-pack', { configDir: linked, repoRoot })).rejects.toMatchObject(
        {
          code: ErrorCodes.INVALID_INPUT,
          message: expect.stringMatching(/outside the repository/),
        }
      );
      await writeFile(
        grantsFilePath(realStore),
        `${JSON.stringify({
          v: 1,
          grants: [{ ...GRANT, source_fingerprint: 'f'.repeat(64) }],
        })}\n`,
        { mode: 0o600 }
      );
      if (process.platform !== 'win32') {
        chmodSync(realStore, 0o755);
        chmodSync(grantsFilePath(realStore), 0o644);
      }

      const readWarnings: string[] = [];
      expect(
        readGrants({
          configDir: linked,
          repoRoot,
          warn: (message) => readWarnings.push(message),
        }).grants
      ).toEqual([]);
      expect(readWarnings.some((warning) => warning.includes('outside the repository'))).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(realStore).mode & 0o777).toBe(0o755);
        expect(statSync(grantsFilePath(realStore)).mode & 0o777).toBe(0o644);
      }

      const warnings: string[] = [];
      const decisions = await computePackTrustDecisions({
        packs: [
          {
            packageId: 'test-pack',
            source: { kind: 'path', path: packPath },
          },
        ],
        repoRoot,
        cliRoot: repoRoot,
        configDir: linked,
        warn: (m) => warnings.push(m),
      });
      expect(decisions.get('test-pack')?.verdict).toBe('refused');
      expect(warnings.some((w) => w.includes('outside the repository'))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  it('refuses an indeterminate dangling store link without creating its target', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-repo-'));
    const linkParent = await mkdtemp(path.join(tmpdir(), 'orcaops-link-'));
    const missingStore = path.join(linkParent, 'missing-store');
    const linked = path.join(linkParent, 'alias');
    try {
      await symlink(missingStore, linked);
      const warnings: string[] = [];

      expect(
        readGrants({
          configDir: linked,
          repoRoot,
          warn: (message) => warnings.push(message),
        }).grants
      ).toEqual([]);
      expect(warnings.some((warning) => warning.includes('outside the repository'))).toBe(true);
      await expect(writeGrant(GRANT, { configDir: linked, repoRoot })).rejects.toMatchObject({
        code: ErrorCodes.INVALID_INPUT,
      });
      await expect(revokeGrant('test-pack', { configDir: linked, repoRoot })).rejects.toMatchObject(
        {
          code: ErrorCodes.INVALID_INPUT,
        }
      );
      expect(existsSync(missingStore)).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});
