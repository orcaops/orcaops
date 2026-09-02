#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The worker ceiling is a rule, not a number, because the two hosts that matter
// are far apart: the bound was measured on an 8-core box, and CI runners are
// smaller still, while a developer machine may have 18. A flat count starves the
// big host — the suite's long tail is one package running alone, which got two
// workers no matter how many cores were idle. A flat percentage does the
// opposite and drops CI below the count that was actually measured.
//
// So: a quarter of the host, never fewer than the 2 that CI measured, never more
// than 4. The cap is not arithmetic — it is measured. At 9 workers on an 18-core
// host, three consecutive forced runs each failed on a wall clock rather than an
// assertion (the CLI's 8-way `concurrency` stress test at its 10s budget, and
// watch's snapshot merge at 5s). Those tests run their own internal fan-out, so
// runner parallelism multiplies with theirs. Raise the cap only with the same
// evidence the original bound required: three consecutive green forced runs.
//
// A coverage run gets the floor instead of the computed ceiling. V8
// instrumentation inflates every test's wall clock on top of the contention,
// so the bound that is safe uninstrumented is not safe with it: measured on an
// 18-core host, the CLI suite under coverage failed four tests at vitest's own
// default (17 workers), one at the cap of 4, and none at 2.
const VITEST_WORKER_SHARE = 0.25;
const VITEST_WORKER_FLOOR = 2;
const VITEST_WORKER_CAP = 4;

const TEST_POLICY = Object.freeze({
  turboConcurrency: '25%',
  vitestWorkerShare: VITEST_WORKER_SHARE,
  vitestWorkerFloor: VITEST_WORKER_FLOOR,
  vitestWorkerCap: VITEST_WORKER_CAP,
  vitestCoverageWorkers: VITEST_WORKER_FLOOR,
  reporter: 'dot',
  silent: 'passed-only',
  isolatedTempRoot: true,
});

const argv = process.argv.slice(2);
if (argv.includes('--print-policy')) {
  process.stdout.write(`${JSON.stringify(TEST_POLICY)}\n`);
  process.exit(0);
}

const coverage = argv.includes('--coverage');
const force = argv.includes('--force');

const vitestMaxWorkers = coverage
  ? VITEST_WORKER_FLOOR
  : Math.min(
      VITEST_WORKER_CAP,
      Math.max(VITEST_WORKER_FLOOR, Math.floor(availableParallelism() * VITEST_WORKER_SHARE))
    );
// `--exclude=<pkg>` drops a workspace from this run. CI uses it to keep the CLI
// out of the shared leg, because its coverage leg already runs the same suite;
// running both means executing every CLI test twice per build.
//
// Names only, deliberately. Turbo accepts a glob here, and a glob matching
// nothing is not an error to it — the run would quietly execute everything,
// which for CI means silently going back to running the CLI suite twice. An
// exact name that matches no workspace does fail, so requiring one keeps the
// mistake loud.
const excluded = argv
  .filter((arg) => arg.startsWith('--exclude='))
  .map((arg) => arg.slice('--exclude='.length))
  .filter((pkg) => pkg.length > 0);

// `--only=<pkg>` is the inverse, and exists so a scoped run — CI's CLI coverage
// leg — still inherits the worker ceiling, the isolated temp root and the build
// turbo already performs, instead of calling vitest directly and bypassing all
// three.
const only = argv
  .filter((arg) => arg.startsWith('--only='))
  .map((arg) => arg.slice('--only='.length))
  .filter((pkg) => pkg.length > 0);

const globbed = [...excluded, ...only].filter((pkg) => /[*?[\]!]/.test(pkg));
if (globbed.length > 0) {
  process.stderr.write(
    `--exclude and --only take an exact workspace name, not a pattern: ${globbed.join(', ')}\n`
  );
  process.exit(2);
}
const forwardedVitestArgs = argv.filter(
  (arg) =>
    arg !== '--' &&
    arg !== '--coverage' &&
    arg !== '--force' &&
    !arg.startsWith('--exclude=') &&
    !arg.startsWith('--only=')
);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const turboManifestPath = require.resolve('turbo/package.json', { paths: [repoRoot] });
const turboManifest = JSON.parse(readFileSync(turboManifestPath, 'utf8'));
const turboBin = path.resolve(path.dirname(turboManifestPath), turboManifest.bin.turbo);

const suiteTempRoot = mkdtempSync(path.join(tmpdir(), 'orcaops-suite-'));
const turboArgs = [
  turboBin,
  'run',
  'test',
  `--concurrency=${TEST_POLICY.turboConcurrency}`,
  ...only.map((pkg) => `--filter=${pkg}`),
  ...excluded.map((pkg) => `--filter=!${pkg}`),
  ...(force ? ['--force'] : []),
  '--',
  `--maxWorkers=${vitestMaxWorkers}`,
  `--reporter=${TEST_POLICY.reporter}`,
  `--silent=${TEST_POLICY.silent}`,
  ...(coverage ? ['--coverage'] : []),
  ...forwardedVitestArgs,
];

let result;
try {
  result = spawnSync(process.execPath, turboArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      TMPDIR: suiteTempRoot,
      TMP: suiteTempRoot,
      TEMP: suiteTempRoot,
    },
    stdio: 'inherit',
  });
} finally {
  rmSync(suiteTempRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

if (result.error) throw result.error;
if (result.signal) {
  process.stderr.write(`test runner terminated by ${result.signal}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
