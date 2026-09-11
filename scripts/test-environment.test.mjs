import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const vitest = path.join(repository, 'node_modules/vitest');

describe('suite storage setup', () => {
  it.each([
    'apps/orcaops-cli/vitest.cli-setup.ts',
    'apps/orcaops-watch/vitest.watch-setup.ts',
    'packages/watch-data/vitest.setup.ts',
  ])(
    'isolates and cleans storage for %s',
    async (setup) => {
      const keys = ['ORCAOPS_DATA_DIR', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
      if (setup.includes('orcaops-cli'))
        keys.push(
          'XDG_STATE_HOME',
          'ORCAOPS_CONFIG_HOME',
          'ORCAOPS_GLOBAL_ROOT',
          'CLAUDE_CONFIG_DIR',
          'CODEX_HOME'
        );
      const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-setup-probe-'));
      try {
        const sentinel = path.join(directory, 'inherited');
        const results = path.join(directory, 'results');
        await mkdir(sentinel);
        await mkdir(results);
        await writeFile(path.join(sentinel, 'existing-history'), 'retained user data\n');
        const files = [];
        for (const name of ['first', 'second']) {
          const file = path.join(directory, `${name}.test.ts`);
          files.push(file);
          await writeFile(
            file,
            `
          import { writeFileSync, realpathSync } from 'node:fs';
          import { expect, test } from ${JSON.stringify(path.join(vitest, 'dist/index.js'))};
          test('uses isolated storage', () => {
            const directories = ${JSON.stringify(keys)}.map(key => {
              const selected = process.env[key];
              expect(selected).toBeTruthy();
              expect(realpathSync(selected)).not.toBe(realpathSync(${JSON.stringify(sentinel)}));
              writeFileSync(selected + '/fixture', 'fixture data');
              return selected;
            });
            writeFileSync(${JSON.stringify(path.join(results, name))}, JSON.stringify(directories));
          });
        `
          );
        }
        const config = path.join(directory, 'vitest.config.mjs');
        await writeFile(
          config,
          `export default ${JSON.stringify({
            test: {
              root: repository,
              include: files,
              setupFiles: [path.join(repository, setup)],
              maxWorkers: 1,
              pool: 'forks',
            },
          })};`
        );
        await exec(process.execPath, [path.join(vitest, 'vitest.mjs'), 'run', '--config', config], {
          cwd: repository,
          env: { ...process.env, ...Object.fromEntries(keys.map((key) => [key, sentinel])) },
          timeout: 30_000,
        });
        const directories = (
          await Promise.all(
            ['first', 'second'].map(async (name) =>
              JSON.parse(await readFile(path.join(results, name), 'utf8'))
            )
          )
        ).flat();
        expect(new Set(directories).size).toBe(keys.length * 2);
        expect(directories.every((directory) => !existsSync(directory))).toBe(true);
        expect(await readdir(sentinel)).toEqual(['existing-history']);
        expect(await readFile(path.join(sentinel, 'existing-history'), 'utf8')).toBe(
          'retained user data\n'
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    45_000
  );
});
