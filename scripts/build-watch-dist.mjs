#!/usr/bin/env node
// Build a distributable @orcaops/watch tarball.
//
// Nothing to esbuild and no bundledDependencies to stage: `bun scripts/build.ts`
// has already bundled the app, inlining the unpublished @orcaops/* packages.
//
// The staged manifest is written from scratch, never copied. That is what keeps
// a workspace:* / file: specifier out of a published artifact.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectPackages, renderNotice } from './third-party-notices.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH_DIR = path.join(ROOT, 'apps', 'orcaops-watch');
const BUILD_DIR = path.join(ROOT, 'build', 'watch-dist');
const STAGING = path.join(BUILD_DIR, 'staging');
const TMP = path.join(BUILD_DIR, 'tmp');
const RELEASE = path.join(ROOT, 'dist-release');

// Inlined into dist/*.js by the Bun build, so their third-party dependencies
// need attribution even though nothing ever installs them.
const INLINED_WORKSPACE_PACKAGES = [
  '@orcaops/core',
  '@orcaops/diff-render',
  '@orcaops/evaluator-protocol',
  '@orcaops/project-scope',
  '@orcaops/review-core',
  '@orcaops/review-engine',
  '@orcaops/storage',
];

function log(msg) {
  process.stdout.write(`\x1b[36m[release:watch]\x1b[0m ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`\x1b[33m[release:watch] WARN:\x1b[0m ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\x1b[31m[release:watch] ERROR:\x1b[0m ${msg}\n`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.status !== 0) fail(`\`${cmd} ${args.join(' ')}\` exited ${res.status ?? res.signal}`);
  return res;
}
function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  if (res.status !== 0)
    fail(`\`${cmd} ${args.join(' ')}\` exited ${res.status ?? res.signal}\n${res.stderr ?? ''}`);
  return res.stdout;
}
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const watchPkg = readJson(path.join(WATCH_DIR, 'package.json'));
const VERSION = watchPkg.version;
if (watchPkg.private) fail('apps/orcaops-watch/package.json is still private: true');
log(`@orcaops/watch version ${VERSION}`);

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(RELEASE, { recursive: true });

const watchDist = path.join(WATCH_DIR, 'dist');
if (process.env.SKIP_BUILD === '1') {
  log('SKIP_BUILD=1 — reusing the existing apps/orcaops-watch/dist');
} else {
  if (spawnSync('bun', ['--version'], { encoding: 'utf8' }).status !== 0)
    fail('bun is not on PATH — the watch UI can only be built by Bun (see https://bun.sh)');
  log('Building the watch bundles (bun scripts/build.ts)…');
  run('bun', ['scripts/build.ts'], { cwd: WATCH_DIR });
}
for (const entry of ['main.js', 'sidecar.js']) {
  if (!existsSync(path.join(watchDist, entry))) fail(`missing bundle: dist/${entry}`);
}

log('Checking the built bundles for proprietary code…');
run(
  'node',
  [
    path.join(ROOT, 'scripts', 'check-no-proprietary.mjs'),
    '--externals-from=dist/.build-externals.json',
  ],
  { cwd: WATCH_DIR }
);

cpSync(path.join(WATCH_DIR, 'bin'), path.join(STAGING, 'bin'), { recursive: true });
cpSync(watchDist, path.join(STAGING, 'dist'), { recursive: true });
for (const binName of Object.values(watchPkg.bin ?? {})) {
  chmodSync(path.join(STAGING, binName), 0o755);
}

log('Stripping *.ts / *.tsx / *.d.ts / *.map and sourceMappingURL comments…');
let stripped = 0;
for (const file of walk(STAGING)) {
  if (/\.(ts|tsx|map)$/.test(file)) {
    rmSync(file);
    stripped++;
  } else if (/\.(js|cjs|mjs)$/.test(file)) {
    const code = readFileSync(file, 'utf8');
    if (code.includes('//# sourceMappingURL=')) {
      writeFileSync(file, code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n'));
    }
  }
}
log(`Stripped ${stripped} map/TypeScript file(s)`);

const licenseCandidates = [path.join(WATCH_DIR, 'LICENSE'), path.join(ROOT, 'LICENSE')];
const licenseSrc = licenseCandidates.find((p) => existsSync(p));
if (licenseSrc) {
  cpSync(licenseSrc, path.join(STAGING, 'LICENSE'));
  log(`Included LICENSE from ${path.relative(ROOT, licenseSrc)}`);
} else if (process.env.ALLOW_MISSING_LICENSE === '1') {
  warn(
    'No LICENSE found — staging a DO-NOT-PUBLISH placeholder because ' +
      'ALLOW_MISSING_LICENSE=1. This tarball must not be published.'
  );
  writeFileSync(
    path.join(STAGING, 'LICENSE'),
    [
      'PLACEHOLDER — NOT A LICENSE. DO NOT PUBLISH THIS ARTIFACT.',
      '',
      `This build declares "license": "${watchPkg.license}" but no canonical`,
      'license text was found in the repository. Add the canonical',
      `${watchPkg.license} text at the repository root as LICENSE (or at`,
      'apps/orcaops-watch/LICENSE) and rebuild without ALLOW_MISSING_LICENSE=1.',
      '',
    ].join('\n')
  );
} else {
  fail(
    `no LICENSE file found (looked in ${licenseCandidates
      .map((p) => path.relative(ROOT, p))
      .join(', ')}).\n` +
      `  The manifest declares "${watchPkg.license}", so the artifact must carry that text.\n` +
      `  Add the canonical text, or re-run with ALLOW_MISSING_LICENSE=1 to stage a\n` +
      `  clearly-marked placeholder for pipeline testing only.`
  );
}

generateNotices();

const distPkg = {
  name: watchPkg.name,
  version: VERSION,
  private: false,
  type: 'module',
  description: watchPkg.description,
  license: watchPkg.license,
  repository: watchPkg.repository,
  engines: watchPkg.engines,
  publishConfig: watchPkg.publishConfig,
  bin: watchPkg.bin,
  files: ['bin', 'dist', 'LICENSE', 'THIRD-PARTY-NOTICES'],
  dependencies: watchPkg.dependencies,
};
writeFileSync(path.join(STAGING, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');

const badSpecifiers = Object.entries(distPkg.dependencies ?? {}).filter(([, spec]) =>
  /^(workspace:|file:|link:|portal:)/.test(spec)
);
if (badSpecifiers.length > 0) {
  fail(
    `the staged manifest carries ${badSpecifiers.length} non-registry specifier(s), which fail ` +
      `to install outright:\n${badSpecifiers.map(([n, s]) => `    ${n}: ${s}`).join('\n')}`
  );
}
log(
  `Staged manifest: ${Object.keys(distPkg.dependencies ?? {}).length} runtime deps, none local ✓`
);

log('Packing the distribution tarball (npm pack, cwd=staging)…');
run('npm', ['pack', '--pack-destination', RELEASE], { cwd: STAGING });
const tarball = path.join(RELEASE, `orcaops-watch-${VERSION}.tgz`);
if (!existsSync(tarball)) fail(`expected tarball not produced: ${tarball}`);

const listing = capture('tar', ['-tzf', tarball]).split('\n').filter(Boolean);
const leakedSource = listing.filter((e) => /\.(map|ts|tsx)$/.test(e));
if (leakedSource.length > 0) {
  fail(
    `tarball ships ${leakedSource.length} source/map file(s):\n${leakedSource
      .slice(0, 20)
      .join('\n')}`
  );
}
for (const required of ['package/LICENSE', 'package/THIRD-PARTY-NOTICES']) {
  if (!listing.includes(required)) fail(`tarball is missing ${required}`);
}
log(`Tarball entries: ${listing.length}; zero .map/.ts/.d.ts, LICENSE + notices present ✓`);

// Re-run the licence gate on the EXTRACTED tarball: this and step 3 can only
// disagree if staging corrupted something.
const extracted = path.join(TMP, 'extracted');
mkdirSync(extracted, { recursive: true });
run('tar', ['-xzf', tarball, '-C', extracted]);
const extractedPkg = path.join(extracted, 'package');
log('Re-checking the SHIPPED bytes for proprietary code…');
// Bytes-only: the tarball carries no module graph and no build declaration, so
// markers are all there is to scan.
run('node', [
  path.join(ROOT, 'scripts', 'check-no-proprietary.mjs'),
  '--bytes-only',
  path.join(extractedPkg, 'dist', 'main.js'),
  path.join(extractedPkg, 'dist', 'sidecar.js'),
]);

if (process.env.SKIP_GATE === '1') {
  log('SKIP_GATE=1 — skipping the install smoke');
} else {
  smokeInstall();
}

const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
const sumsPath = path.join(RELEASE, 'SHA256SUMS-watch');
writeFileSync(sumsPath, `${sha}  ${path.basename(tarball)}\n`);

const sizeMb = (statSync(tarball).size / 1024 / 1024).toFixed(2);
log('');
log(`\x1b[32mDONE\x1b[0m  ${path.relative(ROOT, tarball)}  (${sizeMb} MB)`);
log(`sha256  ${sha}`);
log(
  `Wrote   ${path.relative(ROOT, sumsPath)}  (verify: cd ${path.relative(
    ROOT,
    RELEASE
  )} && shasum -a 256 -c SHA256SUMS-watch)`
);

function smokeInstall() {
  const prefix = path.join(TMP, 'smoke');
  mkdirSync(prefix, { recursive: true });
  writeFileSync(
    path.join(prefix, 'package.json'),
    JSON.stringify({ name: 'orcaops-watch-smoke', version: '0.0.0', private: true }, null, 2) + '\n'
  );

  log('Install smoke: installing the tarball (all deps from the registry)…');
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: prefix,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|offline/i.test(output)) {
      warn('install smoke could not reach the npm registry — skipping (not a tarball fault)');
      return;
    }
    process.stderr.write(output);
    fail('install smoke failed — the tarball does not install');
  }

  const installed = path.join(prefix, 'node_modules', '@orcaops', 'watch');
  if (!existsSync(path.join(installed, 'package.json')))
    fail('install smoke: @orcaops/watch is not present after install');
  const installedVersion = readJson(path.join(installed, 'package.json')).version;
  if (installedVersion !== VERSION)
    fail(`install smoke: installed version ${installedVersion}, expected ${VERSION}`);

  for (const entry of ['dist/main.js', 'dist/sidecar.js', 'LICENSE', 'THIRD-PARTY-NOTICES']) {
    if (!existsSync(path.join(installed, entry)))
      fail(`install smoke: installed package is missing ${entry}`);
  }
  const binLink = path.join(prefix, 'node_modules', '.bin', 'orcaops-watch');
  if (!existsSync(binLink)) fail('install smoke: the orcaops-watch bin was not linked');

  // Written INTO the installed dist/ so import.meta.resolve runs under the same
  // directory and ESM semantics as the bundles. It must not resolve
  // "<pkg>/package.json": several of these packages do not export it.
  const runtimeDeps = Object.keys(distPkg.dependencies ?? {});
  const probePath = path.join(installed, 'dist', '__resolve-probe.mjs');
  writeFileSync(
    probePath,
    [
      `const specs = ${JSON.stringify(runtimeDeps)};`,
      'const missing = [];',
      'for (const spec of specs) {',
      '  try { import.meta.resolve(spec); } catch (err) { missing.push(`${spec}: ${err.code ?? err.message}`); }',
      '}',
      'if (missing.length > 0) {',
      '  console.error("unresolvable from the installed package:\\n  " + missing.join("\\n  "));',
      '  process.exit(1);',
      '}',
      'console.log(`all ${specs.length} runtime deps resolve from the installed package`);',
    ].join('\n')
  );
  const probeRes = spawnSync('node', [probePath], { cwd: prefix, encoding: 'utf8' });
  rmSync(probePath, { force: true });
  if (probeRes.status !== 0) {
    process.stderr.write(`${probeRes.stdout ?? ''}${probeRes.stderr ?? ''}`);
    fail('install smoke: a runtime dependency does not resolve from the installed package');
  }
  log(`Install smoke: ${probeRes.stdout.trim()} ✓`);
}

function generateNotices() {
  // Two seeds, because two populations ship: the runtime closure a consumer
  // installs, and the third-party deps of the workspace packages Bun inlined
  // into dist/, which no manifest mentions.
  const seeds = [...Object.keys(watchPkg.dependencies ?? {}), ...INLINED_WORKSPACE_PACKAGES];
  let found;
  try {
    found = collectPackages({ seeds, from: WATCH_DIR, rootDir: ROOT });
  } catch (error) {
    fail(error.message);
  }

  const parts = [
    '@orcaops/watch — Third-Party Notices',
    '====================================',
    '',
    'This distribution bundles and depends on third-party software. Their license',
    'notices are reproduced below for attribution; the terms differ per package,',
    'so read each entry. Entries cover both the packages a consumer installs and',
    'the packages inlined into dist/main.js and dist/sidecar.js at build time.',
    '',
  ];
  for (const key of [...found.keys()].sort()) {
    try {
      parts.push(...renderNotice(found.get(key), { rootDir: ROOT }));
    } catch (error) {
      fail(error.message);
    }
  }
  writeFileSync(path.join(STAGING, 'THIRD-PARTY-NOTICES'), parts.join('\n'));
  log(`Generated THIRD-PARTY-NOTICES for ${found.size} package(s)`);
}
