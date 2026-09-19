import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { stringify } from 'yaml';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const turbo = path.join(path.dirname(require.resolve('turbo/package.json')), 'bin/turbo');
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const manifest = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function scratch() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'workspace-cache-')));
  roots.push(root);
  const cwd = path.join(root, 'repo with spaces');
  await mkdir(cwd);
  const write = async (file, contents) => {
    const target = path.join(cwd, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  return { root, cwd, write };
}

it('preserves the root CLI command without installing the application at the root', async () => {
  const f = await scratch();
  const root = await manifest(path.join(repository, 'package.json'));
  const launcher = await manifest(path.join(repository, 'packages/dev-cli/package.json'));
  expect(root.devDependencies[launcher.name]).toBe('workspace:*');
  await f.write(
    'package.json',
    JSON.stringify({
      private: true,
      packageManager: root.packageManager,
      devDependencies: { [launcher.name]: root.devDependencies[launcher.name] },
    })
  );
  await f.write('pnpm-workspace.yaml', 'packages: ["apps/*", "packages/*"]\n');
  await f.write('packages/dev-cli/package.json', JSON.stringify(launcher));
  await f.write(
    'packages/dev-cli/orcaops.mjs',
    await readFile(path.join(repository, 'packages/dev-cli/orcaops.mjs'))
  );
  await f.write(
    'apps/orcaops-cli/package.json',
    JSON.stringify({
      name: '@orcaops/cli',
      type: 'module',
      dependencies: { '@orcaops/watch': 'workspace:*' },
    })
  );
  await f.write('apps/orcaops-watch/package.json', JSON.stringify({ name: '@orcaops/watch' }));
  await f.write(
    'apps/orcaops-cli/bin/orcaops.js',
    `import { createRequire } from 'node:module';
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2), entrypoint: process.argv[1], cwd: process.cwd(),
  watch: createRequire(import.meta.url).resolve('@orcaops/watch/package.json')
}));
process.stderr.write('fixture stderr');
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? 0);
`
  );
  await exec('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: f.cwd });
  await expect(
    readFile(path.join(f.cwd, 'node_modules/@orcaops/cli/package.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    readFile(path.join(f.cwd, 'node_modules/@orcaops/watch/package.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  const args = ['a path/$literal`name`', '--value=two words'];
  const invocationDirectory = path.join(f.cwd, 'nested directory');
  await mkdir(invocationDirectory);
  const result = await exec('pnpm', ['exec', 'orcaops', ...args], { cwd: invocationDirectory });
  expect(JSON.parse(result.stdout)).toEqual({
    args,
    entrypoint: path.join(f.cwd, 'apps/orcaops-cli/bin/orcaops.js'),
    cwd: f.cwd,
    watch: path.join(f.cwd, 'apps/orcaops-watch/package.json'),
  });
  expect(result.stderr).toBe('fixture stderr');
  const direct = await exec(
    process.execPath,
    [path.join(f.cwd, 'packages/dev-cli/orcaops.mjs'), ...args],
    {
      cwd: invocationDirectory,
    }
  );
  expect(JSON.parse(direct.stdout)).toEqual({
    ...JSON.parse(result.stdout),
    cwd: invocationDirectory,
  });
  await expect(
    exec('pnpm', ['exec', 'orcaops'], {
      cwd: f.cwd,
      env: { ...process.env, FIXTURE_EXIT_CODE: '23' },
    })
  ).rejects.toMatchObject({ code: 23, stderr: 'fixture stderr' });
}, 30_000);

it('retains unrelated caches while tracking application, upstream and shared tooling edits', async () => {
  const f = await scratch();
  const manifests = new Map([['.', await manifest(path.join(repository, 'package.json'))]]);
  for (const directory of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(repository, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = `${directory}/${entry.name}`;
      try {
        manifests.set(relative, await manifest(path.join(repository, relative, 'package.json')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const locations = new Map([...manifests].map(([location, value]) => [value.name, location]));
  const importers = {};
  for (const [location, value] of manifests) {
    const item = {
      name: value.name,
      private: true,
      packageManager: manifests.get('.').packageManager,
    };
    const importer = {};
    for (const group of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const entries = Object.entries(value[group] ?? {}).filter(([name]) => locations.has(name));
      if (!entries.length) continue;
      item[group] = Object.fromEntries(entries);
      importer[group] = Object.fromEntries(
        entries.map(([name, specifier]) => [
          name,
          {
            specifier,
            version: `link:${path.relative(location, locations.get(name))}`,
          },
        ])
      );
    }
    if (location !== '.') {
      item.scripts = Object.fromEntries(
        ['build', 'test']
          .filter((task) => value.scripts?.[task])
          .map((task) => [task, `node ../../scripts/task.cjs ${task}`])
      );
      await f.write(`${location}/src/index.js`, 'export const value = 1;\n');
    }
    await f.write(`${location}/package.json`, JSON.stringify(item));
    importers[location] = importer;
  }
  await f.write('pnpm-workspace.yaml', 'packages: ["apps/*", "packages/*"]\n');
  await f.write('pnpm-lock.yaml', stringify({ lockfileVersion: '9.0', importers }));
  await f.write('.gitignore', '.turbo/\nnode_modules/\ndist/\n.vitest-reports/\n');
  await f.write(
    'scripts/run-vitest.mjs',
    await readFile(path.join(repository, 'scripts/run-vitest.mjs'))
  );
  await f.write(
    'scripts/task.cjs',
    `const fs = require('node:fs');
const task = process.argv[2];
const name = JSON.parse(fs.readFileSync('package.json')).name;
const output = task === 'build' ? 'dist' : '.vitest-reports';
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(output + '/result', fs.readFileSync('src/index.js'));
fs.appendFileSync(process.env.FIXTURE_OBSERVATIONS, JSON.stringify({ name, task }) + '\\n');
`
  );
  const config = await manifest(path.join(repository, 'turbo.json'));
  await f.write(
    'turbo.json',
    JSON.stringify({
      globalDependencies: config.globalDependencies,
      tasks: Object.fromEntries(
        ['build', 'test'].map((task) => [
          task,
          {
            ...config.tasks[task],
            passThroughEnv: ['FIXTURE_OBSERVATIONS'],
          },
        ])
      ),
    })
  );
  const observations = path.join(f.root, 'observations');
  await writeFile(observations, '');
  const env = { ...process.env, FIXTURE_OBSERVATIONS: observations, TURBO_TELEMETRY_DISABLED: '1' };
  delete env.ORCAOPS_TEST_ARGS;
  const run = () =>
    exec(
      process.execPath,
      [
        turbo,
        'run',
        'test',
        '--filter=@orcaops/cli',
        '--filter=@orcaops/storage',
        '--filter=@orcaops/diff-render',
      ],
      { cwd: f.cwd, env }
    );
  const count = async (name, task = 'test') =>
    (await readFile(observations, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter((record) => record.name === name && record.task === task).length;
  await run();
  await run();
  expect(await count('@orcaops/cli')).toBe(1);
  expect(await count('@orcaops/storage')).toBe(1);
  expect(await count('@orcaops/diff-render')).toBe(1);

  await f.write('apps/orcaops-cli/src/index.js', 'export const value = 2;\n');
  await run();
  expect(await count('@orcaops/cli')).toBe(2);
  expect(await count('@orcaops/core', 'build')).toBe(1);
  expect(await count('@orcaops/storage')).toBe(1);
  expect(await count('@orcaops/diff-render')).toBe(1);

  await f.write('packages/core/src/index.js', 'export const value = 2;\n');
  await run();
  expect(await count('@orcaops/core', 'build')).toBe(2);
  expect(await count('@orcaops/cli')).toBe(3);
  expect(await count('@orcaops/storage')).toBe(1);
  expect(await count('@orcaops/diff-render')).toBe(1);

  await f.write('packages/eslint-config/src/index.js', 'export const value = 2;\n');
  await run();
  expect(await count('@orcaops/storage')).toBe(2);
  expect(await count('@orcaops/diff-render')).toBe(2);
}, 60_000);
