import { run } from 'effection';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type LlmProvider, probeProviderAvailability } from './detect.js';
import { resolvePreparedInputExecutable } from './prepared-input-executable.js';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-executable-')));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };
const overrides = { codex: 'ORCAOPS_CODEX_PATH', claude: 'ORCAOPS_CLAUDE_PATH' };

async function officialPackage(provider: LlmProvider, root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: packages[provider],
      type: 'module',
      bin: { [provider]: 'cli.js' },
    })
  );
  const entrypoint = path.join(root, 'cli.js');
  await writeFile(entrypoint, 'process.stdout.write("version\\n");');
  return entrypoint;
}

describe.each(['codex', 'claude'] as const)('prepared-input executable for %s', (provider) => {
  it('skips unbranded shell and JavaScript wrappers and resolves the native symlink', async () => {
    const directories = ['shell', 'javascript', 'native'].map((name) => path.join(scratch, name));
    for (const directory of directories) await mkdir(directory);
    await writeFile(path.join(directories[0]!, provider), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    await writeFile(
      path.join(directories[1]!, provider),
      '#!/usr/bin/env node\nprocess.exit(99);',
      { mode: 0o755 }
    );
    await symlink(process.execPath, path.join(directories[2]!, provider));
    expect(
      await resolvePreparedInputExecutable(
        provider,
        { PATH: directories.join(path.delimiter) },
        scratch
      )
    ).toEqual({ argv: [await realpath(process.execPath)] });
  });

  it('runs an official package entrypoint with the current runtime instead of a PATH node shim', async () => {
    const entrypoint = await officialPackage(provider, path.join(scratch, 'package'));
    await symlink(entrypoint, path.join(scratch, provider));
    await writeFile(path.join(scratch, 'node'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    expect(await resolvePreparedInputExecutable(provider, { PATH: scratch }, scratch)).toEqual({
      argv: [process.execPath, entrypoint],
    });
  });

  it.each(['global', 'local'] as const)(
    'resolves a %s package shim without executing it',
    async (layout) => {
      const modules = path.join(scratch, 'node_modules');
      const binDir = layout === 'local' ? path.join(modules, '.bin') : scratch;
      await mkdir(binDir, { recursive: true });
      const entrypoint = await officialPackage(provider, path.join(modules, packages[provider]));
      await writeFile(path.join(binDir, provider), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      expect(await resolvePreparedInputExecutable(provider, { PATH: binDir }, scratch)).toEqual({
        argv: [process.execPath, entrypoint],
      });
    }
  );

  it('honors an explicit official entrypoint', async () => {
    const entrypoint = await officialPackage(provider, path.join(scratch, 'package'));
    expect(
      await resolvePreparedInputExecutable(
        provider,
        { [overrides[provider]]: entrypoint, PATH: '' },
        scratch
      )
    ).toEqual({ argv: [process.execPath, entrypoint] });
  });

  it.each(['absolute', 'command'] as const)(
    'refuses an explicit %s wrapper instead of choosing a later CLI',
    async (kind) => {
      const wrapper = path.join(scratch, provider);
      await writeFile(wrapper, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const later = path.join(scratch, 'later');
      await mkdir(later);
      await symlink(process.execPath, path.join(later, provider));
      const result = await resolvePreparedInputExecutable(
        provider,
        {
          [overrides[provider]]: kind === 'absolute' ? wrapper : provider,
          PATH: [scratch, later].join(path.delimiter),
        },
        scratch
      );
      expect(result).toMatchObject({ error: expect.stringContaining(overrides[provider]) });
    }
  );

  it('rejects scripts from other packages and undeclared scripts in the provider package', async () => {
    const root = path.join(scratch, 'package');
    const entrypoint = await officialPackage(provider, root);
    const extra = path.join(root, 'wrapper.js');
    await writeFile(extra, 'process.exit(99);');
    expect(
      await resolvePreparedInputExecutable(provider, { [overrides[provider]]: extra }, scratch)
    ).toHaveProperty('error');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: '@another/product',
        bin: { [provider]: 'cli.js' },
      })
    );
    expect(
      await resolvePreparedInputExecutable(provider, { [overrides[provider]]: entrypoint }, scratch)
    ).toHaveProperty('error');
  });

  it('reports a missing installation without falling back to ambient PATH', async () => {
    expect(
      await resolvePreparedInputExecutable(provider, { PATH: scratch }, scratch)
    ).toMatchObject({ error: expect.stringContaining('no executable was found') });
  });
});

it('uses the same launcher exclusion during knowledge provider probes', async () => {
  const marker = path.join(scratch, 'wrapper-ran');
  for (const provider of ['claude', 'codex']) {
    await writeFile(path.join(scratch, provider), `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
  }
  expect(
    await run(() =>
      probeProviderAvailability({
        env: { PATH: scratch },
        cwd: scratch,
        execution: 'prepared-input',
      })
    )
  ).toEqual({ claude: 'absent', codex: 'absent' });
  expect(existsSync(marker)).toBe(false);
});
