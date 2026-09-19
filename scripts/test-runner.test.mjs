import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const turboManifest = require.resolve('turbo/package.json');
const turbo = path.join(path.dirname(turboManifest), 'bin/turbo');
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'test-runner-'));
  roots.push(root);
  const cwd = path.join(root, 'repo');
  const files = {
    'package.json': JSON.stringify({ private: true, packageManager: 'pnpm@10.18.2' }),
    'pnpm-workspace.yaml': 'packages: ["packages/*"]\n',
    'pnpm-lock.yaml': `lockfileVersion: '9.0'
importers:
  .: {}
  packages/core: {}
  packages/app:
    dependencies:
      '@fixture/core':
        specifier: workspace:*
        version: link:../core
`,
    '.gitignore': 'node_modules/\ndist/\n.turbo/\n',
    'scripts/run-vitest.mjs': await readFile(path.join(repository, 'scripts/run-vitest.mjs')),
    'scripts/build.cjs': `const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.js', fs.readFileSync('src/index.js'));
fs.appendFileSync(process.env.FIXTURE_OBSERVATIONS, 'build ' + process.cwd() + '\\n');
`,
    'node_modules/vitest/package.json': JSON.stringify({
      name: 'vitest',
      type: 'module',
      exports: { './package.json': './package.json' },
      bin: { vitest: './cli.mjs' },
    }),
    'node_modules/vitest/cli.mjs': `import fs from 'node:fs';
fs.appendFileSync(process.env.FIXTURE_OBSERVATIONS, JSON.stringify({
  args: process.argv.slice(2), inherited: process.env.ORCAOPS_TEST_ARGS ?? null
}) + '\\n');
`,
  };
  const config = JSON.parse(await readFile(path.join(repository, 'turbo.json'), 'utf8'));
  files['turbo.json'] = JSON.stringify({
    tasks: {
      build: { ...config.tasks.build, passThroughEnv: ['FIXTURE_OBSERVATIONS'] },
      test: { ...config.tasks.test, passThroughEnv: ['FIXTURE_OBSERVATIONS'] },
    },
  });
  for (const pkg of ['core', 'app']) {
    files[`packages/${pkg}/package.json`] = JSON.stringify({
      name: `@fixture/${pkg}`,
      scripts: {
        build: 'node ../../scripts/build.cjs',
        test: 'node ../../scripts/run-vitest.mjs',
      },
      ...(pkg === 'app' ? { dependencies: { '@fixture/core': 'workspace:*' } } : {}),
    });
    files[`packages/${pkg}/src/index.js`] = 'export const value = 1;\n';
  }
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(cwd, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const observations = path.join(root, 'observations');
  await writeFile(observations, '');
  const env = { ...process.env, FIXTURE_OBSERVATIONS: observations, TURBO_TELEMETRY_DISABLED: '1' };
  delete env.ORCAOPS_TEST_ARGS;
  const run = (args, options = {}) => exec(process.execPath, args, { cwd, env, ...options });
  const records = async () =>
    (await readFile(observations, 'utf8')).trim().split('\n').filter(Boolean);
  return { cwd, env, run, records };
}

it('keeps test options literal and local to the Vitest invocation', async () => {
  const f = await fixture();
  const options = ['--coverage', '--shard=2/4', 'a path/$literal`name`.test.ts'];
  await f.run(['../../scripts/run-vitest.mjs', '--passWithNoTests'], {
    cwd: path.join(f.cwd, 'packages/app'),
    env: { ...f.env, ORCAOPS_TEST_ARGS: JSON.stringify(options) },
  });
  expect((await f.records()).map(JSON.parse)).toEqual([
    { args: ['run', ...options, '--passWithNoTests'], inherited: null },
  ]);
  for (const invalid of ['not json', '{}', '[1]']) {
    await expect(
      f.run(['scripts/run-vitest.mjs'], { env: { ...f.env, ORCAOPS_TEST_ARGS: invalid } })
    ).rejects.toMatchObject({ code: 1 });
  }
  expect(await f.records()).toHaveLength(1);
});

it('reuses builds across test options while invalidating tests for options and dependency changes', async () => {
  const f = await fixture();
  const run = (options) =>
    f.run([turbo, 'run', 'test', '--filter=@fixture/app'], {
      env: { ...f.env, ORCAOPS_TEST_ARGS: JSON.stringify(options) },
    });
  const buildCount = async () =>
    (await f.records()).filter((line) => line.startsWith('build ')).length;
  const testCount = async () => (await f.records()).filter((line) => line.startsWith('{')).length;

  await run(['--shard=1/4']);
  expect(await buildCount()).toBe(2);
  expect(await testCount()).toBe(1);
  await run(['--coverage', '--shard=2/4']);
  expect(await buildCount()).toBe(2);
  expect(await testCount()).toBe(2);
  await run(['--coverage', '--shard=2/4']);
  expect(await buildCount()).toBe(2);
  expect(await testCount()).toBe(2);

  await writeFile(path.join(f.cwd, 'packages/core/src/index.js'), 'export const value = 2;\n');
  await run(['--coverage', '--shard=2/4']);
  expect(await buildCount()).toBe(4);
  expect(await testCount()).toBe(3);

  await writeFile(
    path.join(f.cwd, 'scripts/run-vitest.mjs'),
    `${await readFile(path.join(f.cwd, 'scripts/run-vitest.mjs'), 'utf8')}\n`
  );
  await run(['--coverage', '--shard=2/4']);
  expect(await buildCount()).toBe(4);
  expect(await testCount()).toBe(4);
}, 30_000);
