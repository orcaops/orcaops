import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  chooseTmpDir,
  type CompanionInputs,
  needsTerminal,
  resolveWatchCompanion,
  WATCH_PLATFORMS,
} from './watch-companion.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'orcaops-watch-companion-'));
}

function writeCli(root: string, pins: boolean): void {
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'watch-sidecar.js'), '');
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@orcaops/cli',
      version: '1.2.3',
      optionalDependencies: pins
        ? Object.fromEntries(WATCH_PLATFORMS.map((p) => [p.package, '1.2.3']))
        : {},
    })
  );
}

function writePlatform(root: string, name: string, version: string, executable = true): void {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version, orcaopsWatch: { exe: 'bin/orcaops-watch-ui' } })
  );
  const exe = path.join(dir, 'bin', 'orcaops-watch-ui');
  writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  chmodSync(exe, executable ? 0o755 : 0o644);
}

function inputs(root: string, overrides: Partial<CompanionInputs> = {}): CompanionInputs {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  return {
    env: { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() },
    platform: 'darwin',
    arch: 'arm64',
    musl: false,
    cliManifest: manifest,
    cliRoot: root,
    requireResolve: (specifier) => {
      const file = path.join(root, 'node_modules', specifier);
      if (!readFileSync(file)) throw new Error('unreachable');
      return file;
    },
    execPath: '/usr/local/bin/node',
    runningUnderBun: false,
    homeDir: root,
    ...overrides,
  };
}

describe('WATCH_PLATFORMS', () => {
  it('mirrors apps/orcaops-watch/platforms.json', () => {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../orcaops-watch/platforms.json'
    );
    const declared = JSON.parse(readFileSync(file, 'utf8')) as Array<{
      package: string;
      os: string;
      cpu: string;
      libc?: string;
    }>;
    expect(
      declared.map(({ package: p, os, cpu, libc }) => ({ package: p, os, cpu, libc }))
    ).toEqual(
      WATCH_PLATFORMS.map(({ package: p, os, cpu, libc }) => ({ package: p, os, cpu, libc }))
    );
  });
});

describe('resolveWatchCompanion', () => {
  it('launches the installed platform package with the full hand-off environment', () => {
    const root = scratch();
    writeCli(root, true);
    writePlatform(root, '@orcaops/watch-darwin-arm64', '1.2.3');
    const launch = resolveWatchCompanion(
      inputs(root, {
        env: {
          PATH: '/usr/bin',
          TMPDIR: tmpdir(),
          BUN_OPTIONS: '--preload x',
          BUN_BE_BUN: '1',
          OTUI_TREE_SITTER_WORKER_PATH: '/x',
        },
      })
    );
    expect(launch.kind).toBe('launch');
    if (launch.kind !== 'launch') return;
    expect(launch.tier).toBe('platform');
    expect(launch.command).toBe(
      path.join(root, 'node_modules', '@orcaops', 'watch-darwin-arm64', 'bin', 'orcaops-watch-ui')
    );
    expect(launch.env.ORCAOPS_WATCH_SIDECAR).toBe(path.join(root, 'dist', 'watch-sidecar.js'));
    expect(launch.env.ORCAOPS_WATCH_NODE).toBe('/usr/local/bin/node');
    expect(launch.env.ORCAOPS_WATCH_DEPS_ROOT).toBe(root);
    expect(launch.env.TMPDIR).toBe(tmpdir());
    expect(launch.env.BUN_OPTIONS).toBeUndefined();
    expect(launch.env.BUN_BE_BUN).toBeUndefined();
    expect(launch.env.OTUI_TREE_SITTER_WORKER_PATH).toBeUndefined();
    expect(launch.companion).toEqual({
      name: '@orcaops/watch-darwin-arm64',
      version: '1.2.3',
      root: path.join(root, 'node_modules', '@orcaops', 'watch-darwin-arm64'),
    });
  });

  it('refuses ORCAOPS_WATCH_BIN on a pinned CLI and honours it on an unpinned one', () => {
    const pinned = scratch();
    writeCli(pinned, true);
    const refused = resolveWatchCompanion(
      inputs(pinned, { env: { ORCAOPS_WATCH_BIN: '/somewhere/else' } })
    );
    expect(refused).toMatchObject({ kind: 'refuse', tier: 'refused-override', exitCode: 127 });

    const unpinned = scratch();
    writeCli(unpinned, false);
    const honoured = resolveWatchCompanion(
      inputs(unpinned, {
        env: { ORCAOPS_WATCH_BIN: '/somewhere/else', BUN_OPTIONS: '--preload x' },
      })
    );
    expect(honoured).toMatchObject({
      kind: 'launch',
      tier: 'override',
      command: '/somewhere/else',
    });
    if (honoured.kind === 'launch') expect(honoured.env.BUN_OPTIONS).toBeUndefined();
  });

  it('reports an unsupported host for unknown platforms and musl', () => {
    const root = scratch();
    writeCli(root, true);
    expect(resolveWatchCompanion(inputs(root, { platform: 'win32', arch: 'x64' }))).toMatchObject({
      kind: 'refuse',
      tier: 'unsupported',
    });
    const musl = resolveWatchCompanion(
      inputs(root, { platform: 'linux', arch: 'x64', musl: true })
    );
    expect(musl).toMatchObject({ kind: 'refuse', tier: 'unsupported' });
    if (musl.kind === 'refuse') expect(musl.message).toContain('linux-x64-musl');
  });

  it('names the reinstall command when the companion is absent', () => {
    const root = scratch();
    writeCli(root, true);
    const absent = resolveWatchCompanion(inputs(root));
    expect(absent).toMatchObject({ kind: 'refuse', tier: 'absent', exitCode: 127 });
    if (absent.kind === 'refuse') expect(absent.message).toContain('npm i -g @orcaops/cli@1.2.3');
  });

  it('treats a version mismatch and a non-executable binary as broken', () => {
    const mismatch = scratch();
    writeCli(mismatch, true);
    writePlatform(mismatch, '@orcaops/watch-darwin-arm64', '9.9.9');
    const wrongVersion = resolveWatchCompanion(inputs(mismatch));
    expect(wrongVersion).toMatchObject({ kind: 'refuse', tier: 'broken' });
    if (wrongVersion.kind === 'refuse') expect(wrongVersion.message).toContain('is 9.9.9');

    const notExecutable = scratch();
    writeCli(notExecutable, true);
    writePlatform(notExecutable, '@orcaops/watch-darwin-arm64', '1.2.3', false);
    const noExec = resolveWatchCompanion(inputs(notExecutable));
    expect(noExec).toMatchObject({ kind: 'refuse', tier: 'broken' });
    if (noExec.kind === 'refuse') expect(noExec.message).toContain('not executable');
  });

  it('finds node on PATH for the sidecar when the CLI itself runs under Bun', () => {
    const root = scratch();
    writeCli(root, true);
    writePlatform(root, '@orcaops/watch-darwin-arm64', '1.2.3');
    // A directory named node earlier on PATH is not a binary.
    const decoy = path.join(root, 'decoy-bin');
    mkdirSync(path.join(decoy, 'node'), { recursive: true });
    const binDir = path.join(root, 'fake-bin');
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, 'node'), '');
    chmodSync(path.join(binDir, 'node'), 0o755);
    const launch = resolveWatchCompanion(
      inputs(root, {
        env: { PATH: `${decoy}${path.delimiter}${binDir}`, TMPDIR: tmpdir() },
        execPath: '/opt/bun/bin/bun',
        runningUnderBun: true,
      })
    );
    expect(launch.kind).toBe('launch');
    if (launch.kind === 'launch')
      expect(launch.env.ORCAOPS_WATCH_NODE).toBe(path.join(binDir, 'node'));
  });

  it('falls back to the workspace app under Bun only without platform pins', () => {
    const root = scratch();
    writeCli(root, false);
    const app = path.join(root, 'node_modules', '@orcaops', 'watch');
    mkdirSync(path.join(app, 'dist'), { recursive: true });
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@orcaops/watch' }));
    writeFileSync(path.join(app, 'dist', 'main.js'), '');
    writeFileSync(path.join(app, 'dist', 'sidecar.js'), '');
    const dev = resolveWatchCompanion(inputs(root));
    expect(dev).toMatchObject({ kind: 'launch', tier: 'dev', command: 'bun' });
    if (dev.kind === 'launch') {
      expect(dev.args).toEqual([path.join(app, 'dist', 'main.js')]);
      expect(dev.env.ORCAOPS_WATCH_SIDECAR).toBe(path.join(app, 'dist', 'sidecar.js'));
    }

    const pinned = scratch();
    writeCli(pinned, true);
    mkdirSync(path.join(pinned, 'node_modules', '@orcaops', 'watch', 'dist'), { recursive: true });
    writeFileSync(
      path.join(pinned, 'node_modules', '@orcaops', 'watch', 'package.json'),
      JSON.stringify({ name: '@orcaops/watch' })
    );
    writeFileSync(path.join(pinned, 'node_modules', '@orcaops', 'watch', 'dist', 'main.js'), '');
    expect(resolveWatchCompanion(inputs(pinned))).toMatchObject({ kind: 'refuse', tier: 'absent' });
  });
});

describe('chooseTmpDir', () => {
  it('keeps a writable TMPDIR and otherwise makes a private dir under the global root', () => {
    const home = scratch();
    expect(chooseTmpDir({ TMPDIR: home }, home)).toBe(home);
    const chosen = chooseTmpDir({ TMPDIR: path.join(home, 'missing') }, home);
    expect(chosen).toBe(path.join(home, '.orcaops', 'tmp'));
    expect(statSync(chosen).mode & 0o777).toBe(0o700);
    // A pre-existing loose directory is tightened, not trusted.
    chmodSync(chosen, 0o777);
    expect(chooseTmpDir({ TMPDIR: path.join(home, 'missing') }, home)).toBe(chosen);
    expect(statSync(chosen).mode & 0o777).toBe(0o700);
  });
});

describe('needsTerminal', () => {
  it('exempts the headless flags', () => {
    expect(needsTerminal(['--probe', '--root', '/x'])).toBe(false);
    expect(needsTerminal(['--version'])).toBe(false);
    expect(needsTerminal(['--once'])).toBe(true);
    expect(needsTerminal([])).toBe(true);
  });
});
