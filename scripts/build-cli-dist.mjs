#!/usr/bin/env node
// Build a self-contained, source-minified @orcaops/cli tarball for
// distribution. One command -> dist-release/orcaops-cli-<version>.tgz.
//
//   pnpm release:cli
//
// Architecture: esbuild-bundle the CLI + its pure-JS workspace deps
// into a single minified dist/cli/index.js (no sourcemap); ship the unpublished
// eval packs (+ their prod closure) INSIDE the tarball via npm
// `bundledDependencies`; keep the native modules (better-sqlite3, optional
// @napi-rs/keyring) as real deps so each host's `npm i -g` fetches its own
// prebuild. Cross-platform for macOS-arm64 + Linux with no per-platform build.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROPRIETARY_PACKAGES, checkNoProprietary } from './check-no-proprietary.mjs';
import {
  collectPackages,
  enumeratePackages,
  readJson,
  renderNotice as renderNoticeShared,
} from './third-party-notices.mjs';

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = path.join(ROOT, 'apps', 'orcaops-cli');
const BUILD_DIR = path.join(ROOT, 'build', 'cli-dist');
const STAGING = path.join(BUILD_DIR, 'staging');
const TMP = path.join(BUILD_DIR, 'tmp');
const RELEASE = path.join(ROOT, 'dist-release');
const PINS_SRC = path.join(ROOT, 'scripts', 'release-staging-pins.json');

// The unpublished eval packages — shipped on disk (bundledDependencies)
// because they are executed by path as subprocesses and cannot be esbuild-inlined.
const EVAL_PACKS = [
  '@orcaops/evaluator-protocol',
  '@orcaops/evaluator-sdk',
  '@orcaops/evaluator-pack',
];

// Native modules — never bundled; declared as real deps so npm fetches the
// per-platform prebuild on the installing machine. The eval packages remain
// real deps because their subprocess runtimes load them from disk.
//
// The proprietary pins below are EXACT — no caret, no tilde. A range would let
// an install pull unreviewed bytes into an FSL-labelled tree, so moving one of
// them is a licence decision.
// Exact, and guarded below against the version the workspace actually
// installed and tested: the addon the CLI ships must be the one its suite ran.
const BETTER_SQLITE3_VERSION = '13.0.3';
const DIST_DEPENDENCIES = {
  'better-sqlite3': BETTER_SQLITE3_VERSION,
  '@orcaops/evaluator-pack': '0.1.0',
  '@orcaops/evaluator-protocol': '0.1.0',
  '@orcaops/evaluator-sdk': '0.1.0',
  '@orcaops/protocol': '0.0.26',
  '@orcaops/sdk': '0.1.23',
  '@orcaops/diff-fingerprint': '0.0.8',
};
// The compiled Watch UI ships as one os/cpu-filtered optional package per
// platform, versioned with the CLI that launches it; npm installs the one that
// matches the host and silently skips the rest. Their manifest is
// apps/orcaops-watch/platforms.json; the pin is filled in once VERSION is known.
const WATCH_PLATFORMS = JSON.parse(
  readFileSync(path.join(ROOT, 'apps', 'orcaops-watch', 'platforms.json'), 'utf8')
);
const WATCH_PLATFORM_PACKAGES = WATCH_PLATFORMS.map((platform) => platform.package);

// The proprietary packages are listed literally rather than spread from
// PROPRIETARY_PACKAGES: the licence gate asks whether this build declared each
// of them external, and one shared constant would make that check answer itself.
const BUNDLE_EXTERNALS = [
  'better-sqlite3',
  '@napi-rs/keyring',
  '@orcaops/evaluator-pack',
  '@orcaops/protocol',
  '@orcaops/sdk',
  '@orcaops/diff-fingerprint',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg) {
  process.stdout.write(`\x1b[36m[release:cli]\x1b[0m ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\x1b[31m[release:cli] ERROR:\x1b[0m ${msg}\n`);
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
/** Recursively yield absolute file paths under dir. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

// ---------------------------------------------------------------------------
// 1. Version (single source of truth) + clean dirs
// ---------------------------------------------------------------------------
const cliPkg = JSON.parse(readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'));
const VERSION = cliPkg.version;
log(`@orcaops/cli version ${VERSION}`);

const DIST_OPTIONAL_DEPENDENCIES = {
  '@napi-rs/keyring': '^1.3.0',
  ...Object.fromEntries(WATCH_PLATFORM_PACKAGES.map((name) => [name, VERSION])),
};

const installedSqliteVersion = JSON.parse(
  readFileSync(
    createRequire(path.join(CLI_DIR, 'package.json')).resolve('better-sqlite3/package.json'),
    'utf8'
  )
).version;
if (installedSqliteVersion !== BETTER_SQLITE3_VERSION) {
  fail(
    `better-sqlite3 pin drift: the release manifest says ${BETTER_SQLITE3_VERSION} but the ` +
      `workspace installed ${installedSqliteVersion} — move both pins together`
  );
}

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(path.join(STAGING, 'dist', 'cli'), { recursive: true });
mkdirSync(path.join(STAGING, 'bin'), { recursive: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(RELEASE, { recursive: true });

// ---------------------------------------------------------------------------
// 2. Build the workspace (tsc dist) — we bundle from the tested build, not src
// ---------------------------------------------------------------------------
if (process.env.SKIP_BUILD === '1') {
  log('SKIP_BUILD=1 — reusing existing dist/');
} else {
  log('Building workspace (pnpm build)…');
  run('pnpm', ['build']);
}
const cliEntry = path.join(CLI_DIR, 'dist', 'cli', 'index.js');
if (!existsSync(cliEntry)) fail(`CLI entry not found: ${cliEntry} (build failed?)`);

// ---------------------------------------------------------------------------
// 3. esbuild bundle -> staging/dist/cli/index.js (minified, no sourcemap)
// ---------------------------------------------------------------------------
// Marks any specifier ending in package.json as external so the CLI's runtime
// `createRequire(import.meta.url)('../../package.json')` version reads stay LIVE
// (resolving against the installed dist root) rather than being frozen-inlined.
const externalizePackageJson = {
  name: 'externalize-package-json',
  setup(b) {
    b.onResolve({ filter: /(^|\/)package\.json$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

// Shared by both bundles: the CLI and the Watch data sidecar it spawns.
const bundleOptions = {
  bundle: true,
  // The licence gate reads the module graph; output text cannot prove inlining.
  metafile: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'external', // -> dist/cli/index.js.LEGAL.txt (kept for attribution)
  treeShaking: true,
  mainFields: ['module', 'main'],
  conditions: ['node', 'import'], // force effection's ESM build (avoid CJS double-load)
  // ESM-in-node papercut: define a real `require` so esbuild's CJS-interop shim
  // (and inlined CJS deps doing `require('node:events')` etc.) resolve instead of
  // throwing "Dynamic require of X is not supported". Aliased import so it does
  // not collide with the createRequire the bundled CLI code already imports.
  banner: {
    js: "import { createRequire as __cjs_cr } from 'node:module';\nconst require = __cjs_cr(import.meta.url);",
  },
  // Native modules + the on-disk eval pack stay external. evaluator-protocol /
  // evaluator-sdk are intentionally NOT external — inline them into the CLI for
  // its own use; they still ship on disk (closure) for the subprocess.
  external: BUNDLE_EXTERNALS,
  plugins: [externalizePackageJson],
  logLevel: 'info',
};

log('Bundling CLI with esbuild (minify, no sourcemap)…');
const cliOutfile = path.join(STAGING, 'dist', 'cli', 'index.js');
const cliBuild = await build({ ...bundleOptions, entryPoints: [cliEntry], outfile: cliOutfile });

// The Watch data sidecar: the Node process the compiled Task Review UI spawns
// for everything that touches better-sqlite3. Bundled from @orcaops/watch-data's
// built entry so the CLI carries it and the UI never needs a second install.
const sidecarEntry = path.join(ROOT, 'packages', 'watch-data', 'dist', 'sidecar.js');
if (!existsSync(sidecarEntry))
  fail(`watch sidecar entry not found: ${sidecarEntry} (build failed?)`);
log('Bundling the Watch data sidecar with esbuild…');
const sidecarOutfile = path.join(STAGING, 'dist', 'watch-sidecar.js');
const sidecarBuild = await build({
  ...bundleOptions,
  entryPoints: [sidecarEntry],
  outfile: sidecarOutfile,
});

const productionBundles = [cliOutfile, sidecarOutfile];
for (const bundlePath of productionBundles) {
  const text = readFileSync(bundlePath, 'utf8');
  const leakedDevelopmentMarkers = ['orcaops-dev', '--cloud-url', '--data-root'].filter((marker) =>
    text.includes(marker)
  );
  if (leakedDevelopmentMarkers.length > 0) {
    fail(
      `${path.relative(STAGING, bundlePath)} includes development-launcher surface: ${leakedDevelopmentMarkers.join(', ')}`
    );
  }
}
log('Production bundles exclude the development launcher and its selectors ✓');

// 3b. Licence gate — must stay ahead of the LICENSE and `license` staging
// below, which are what turn inlined bytes into an irrevocable grant.
log('Checking the bundle for inlined proprietary code…');
const licenceGate = checkNoProprietary({
  bundles: productionBundles,
  repoRoot: ROOT,
  declaredExternals: BUNDLE_EXTERNALS,
  metafileInputs: { ...cliBuild.metafile.inputs, ...sidecarBuild.metafile.inputs },
});
for (const note of licenceGate.notes) log(note);
if (!licenceGate.ok) {
  process.stderr.write(
    `\x1b[31m[release:cli] ERROR:\x1b[0m the bundle inlines proprietary code:\n` +
      licenceGate.errors.map((e) => `    ${e}\n`).join('') +
      `\n  This build declares "license": "FSL-1.1-ALv2", whose future-license grant is\n` +
      `  IRREVOCABLE. Publishing this tarball would permanently relicense\n` +
      `  ${PROPRIETARY_PACKAGES.join(', ')}.\n\n` +
      `  Each of them belongs in BUNDLE_EXTERNALS and in DIST_DEPENDENCIES as an exact\n` +
      `  pin. One that reappears here arrived TRANSITIVELY through a first-party\n` +
      `  package — add it to BUNDLE_EXTERNALS. Do not relax this gate.\n`
  );
  process.exit(1);
}
log('Both bundles keep every proprietary package external ✓');

// ---------------------------------------------------------------------------
// 4. Materialize the unpublished eval packs (+ closure) into staging/node_modules
//    for bundledDependencies. Write a minimal package.json anchor first.
// ---------------------------------------------------------------------------
// Pin the public transitive closure to exact versions for reproducible reruns,
// applied as npm `overrides` on the staging package.json. (The eval packs are
// repacked from source each run, so they are intentionally NOT pinned here — a
// full npm-shrinkwrap would hit integrity mismatches against the repacked
// tarballs; overrides pin the public closure without coupling to tarball bytes.)
let overrides = {};
if (existsSync(PINS_SRC)) {
  overrides = JSON.parse(readFileSync(PINS_SRC, 'utf8')).overrides ?? {};
  log(
    `Pinning ${Object.keys(overrides).length} public closure deps from release-staging-pins.json`
  );
} else {
  log('No release-staging-pins.json — public ranges resolve fresh (NOT reproducible)');
}
writeFileSync(
  path.join(STAGING, 'package.json'),
  JSON.stringify({ name: '@orcaops/cli', version: VERSION, private: false, overrides }, null, 2) +
    '\n'
);

log('Packing eval packs to tarballs…');
for (const name of EVAL_PACKS) run('pnpm', ['--filter', name, 'pack', '--pack-destination', TMP]);
const evalTarballs = readdirSync(TMP)
  .filter((f) => f.endsWith('.tgz'))
  .map((f) => path.join(TMP, f));
if (evalTarballs.length !== EVAL_PACKS.length)
  fail(`expected ${EVAL_PACKS.length} eval tarballs, found ${evalTarballs.length}`);

log('Installing eval packs into staging node_modules (npm, omit dev)…');
run('npm', ['install', '--no-save', '--omit=dev', ...evalTarballs], { cwd: STAGING });

// ---------------------------------------------------------------------------
// 5. Strip maps + shipped TypeScript across the WHOLE bundled closure, then
//    minify our own @orcaops packs. Makes the "zero .map/.ts" gate pass.
// ---------------------------------------------------------------------------
log('Stripping *.map / *.ts / *.d.ts and sourceMappingURL from the closure…');
let stripped = 0;
for (const dir of [path.join(STAGING, 'node_modules'), path.join(STAGING, 'dist')]) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    if (/\.(ts|tsx|map)$/.test(file)) {
      rmSync(file);
      stripped++;
    } else if (file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs')) {
      const code = readFileSync(file, 'utf8');
      if (code.includes('//# sourceMappingURL=')) {
        writeFileSync(file, code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n'));
      }
    }
  }
}
log(`Stripped ${stripped} map/TypeScript files`);

log('Minifying @orcaops/* pack JS (our IP)…');
let minified = 0;
const orcaopsScope = path.join(STAGING, 'node_modules', '@orcaops');
if (existsSync(orcaopsScope)) {
  for (const file of walk(orcaopsScope)) {
    if (!file.endsWith('.js') && !file.endsWith('.cjs') && !file.endsWith('.mjs')) continue;
    const code = readFileSync(file, 'utf8');
    const out = await build({
      stdin: { contents: code, loader: 'js', resolveDir: path.dirname(file), sourcefile: file },
      write: false,
      minify: true,
      // bundle:false (default) -> imports/exports preserved, format unchanged.
      logLevel: 'silent',
    }).catch(() => null);
    if (out && out.outputFiles?.[0]) {
      writeFileSync(file, out.outputFiles[0].text);
      minified++;
    }
  }
}
log(`Minified ${minified} @orcaops pack files`);

// ---------------------------------------------------------------------------
// 5b. Built-in trust manifest. Fingerprints are computed over the FINAL
// installed (post-minification) covered pack-file bytes. This deliberately does
// not fingerprint interpreters, imported dependencies, or undeclared runtime
// inputs. Changes to covered installed bytes or a mismatched manifest fail
// closed at dispatch. Runs AFTER the strip+minify passes for that reason; see
// docs/evaluator-consent.md.
// ---------------------------------------------------------------------------
log('Generating the built-in evaluator trust manifest…');
const { pathToFileURL } = await import('node:url');
const runnerDistEntry = path.join(ROOT, 'packages', 'evaluator-runner', 'dist', 'index.js');
if (!existsSync(runnerDistEntry)) {
  fail(`trust manifest: build the workspace first (missing ${runnerDistEntry})`);
}
const { resolvePackSource, validatePack, computePackSourceFingerprint, isTrustCapability } =
  await import(pathToFileURL(runnerDistEntry).href);
const packPkgDir = path.join(STAGING, 'node_modules', '@orcaops', 'evaluator-pack');
const installedPacksDir = path.join(packPkgDir, 'dist', 'packs');
const manifestPacks = [];
for (const packId of readdirSync(installedPacksDir).sort()) {
  const resolvedPack = resolvePackSource(
    { kind: 'bundled', package: '@orcaops/evaluator-pack', pack: packId },
    { repoRoot: STAGING, cliRoot: STAGING }
  );
  // Classify with codex as the assumed default provider: the shipped
  // manifest cannot know a user's runtime config, so it must carry the
  // superset of capabilities dispatch could gate. Under a claude default
  // the extra file-reading class is simply never required; omitting it
  // would deadlock bundled implicit-provider evaluators under codex.
  const packValidation = await validatePack(resolvedPack, { defaultLlmProvider: 'codex' });
  if (!packValidation.ok) fail(`trust manifest: installed pack "${packId}" failed validation`);
  const capabilities = packValidation.warnings.map((w) => w.code).filter(isTrustCapability);
  const { fingerprint } = await computePackSourceFingerprint(resolvedPack);
  manifestPacks.push({
    package: '@orcaops/evaluator-pack',
    pack: packId,
    source_fingerprint: fingerprint,
    capabilities,
  });
}
writeFileSync(
  path.join(STAGING, 'dist', 'trust-manifest.json'),
  JSON.stringify({ v: 1, packs: manifestPacks }, null, 2) + '\n'
);
log(`Trust manifest: ${manifestPacks.length} bundled pack(s) pinned to installed bytes`);

// ---------------------------------------------------------------------------
// 6. bin + LICENSE + THIRD-PARTY-NOTICES + README + CHANGELOG
// ---------------------------------------------------------------------------
cpSync(path.join(CLI_DIR, 'bin', 'orcaops.js'), path.join(STAGING, 'bin', 'orcaops.js'));
const rootLicense = path.join(ROOT, 'LICENSE');
if (!existsSync(rootLicense)) fail('root LICENSE is missing; the tarball must carry it');
cpSync(rootLicense, path.join(STAGING, 'LICENSE'));
// npm renders whatever README and CHANGELOG the tarball carries, and a
// published version's page is frozen — staging them is the only chance.
for (const doc of ['README.md', 'CHANGELOG.md']) {
  const source = path.join(ROOT, doc);
  if (!existsSync(source)) fail(`root ${doc} is missing; the npm page needs it`);
  cpSync(source, path.join(STAGING, doc));
}
generateNotices();

// ---------------------------------------------------------------------------
// 7. Finalize package.json (full manifest with bundledDependencies)
// ---------------------------------------------------------------------------
const distPkg = {
  name: '@orcaops/cli',
  version: VERSION,
  private: false,
  type: 'module',
  description: 'orcaops CLI (self-contained distribution build)',
  license: 'FSL-1.1-ALv2',
  author: 'Orcaops Inc.',
  homepage: 'https://orcaops.ai',
  // npm provenance rejects any mismatch against the workflow's repository,
  // including one of case. Keep it exactly as the remote is spelled.
  repository: { type: 'git', url: 'git+https://github.com/orcaops/orcaops.git' },
  bugs: { url: 'https://github.com/orcaops/orcaops/issues' },
  keywords: [
    'orcaops',
    'ai',
    'agent',
    'coding-agent',
    'claude-code',
    'code-review',
    'provenance',
    'audit-trail',
    'evaluator',
    'cli',
  ],
  bin: { orcaops: './bin/orcaops.js' },
  files: ['bin', 'dist', 'LICENSE', 'THIRD-PARTY-NOTICES', 'README.md', 'CHANGELOG.md'],
  engines: { node: '>=22.14.0' },
  // These are the platforms Orcaops supports (README and the getting-started
  // guide say the same). The addon also ships win32 prebuilds, so this is our
  // support boundary, not its capability. It matters more since 13.x: there is
  // no build-from-source fallback, so without this npm would install a CLI that
  // dies on its first store access instead of refusing up front.
  os: ['darwin', 'linux'],
  cpu: ['x64', 'arm64'],
  dependencies: DIST_DEPENDENCIES,
  optionalDependencies: DIST_OPTIONAL_DEPENDENCIES,
  bundledDependencies: [...EVAL_PACKS],
};
writeFileSync(path.join(STAGING, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');

// ---------------------------------------------------------------------------
// 8. npm pack FROM INSIDE staging (only this form includes bundled node_modules)
// ---------------------------------------------------------------------------
log('Packing the distribution tarball (npm pack, cwd=staging)…');
run('npm', ['pack', '--pack-destination', RELEASE], { cwd: STAGING });
const tarball = path.join(RELEASE, `orcaops-cli-${VERSION}.tgz`);
if (!existsSync(tarball)) fail(`expected tarball not produced: ${tarball}`);

// ---------------------------------------------------------------------------
// 9. Gate: no source/maps shipped + real global install smoke
// ---------------------------------------------------------------------------
const listing = capture('tar', ['-tzf', tarball]).split('\n').filter(Boolean);
const leaked = listing.filter((e) => /\.(map|ts|tsx)$/.test(e));
if (leaked.length)
  fail(`tarball ships ${leaked.length} source/map file(s):\n${leaked.slice(0, 20).join('\n')}`);
log(`Tarball entries: ${listing.length}; zero .map/.ts/.d.ts ✓`);

// npm ships a LICENSE it finds whether or not `files` lists it, so the tarball
// listing is the evidence and the manifest is not.
if (!listing.includes('package/LICENSE')) fail('tarball is missing package/LICENSE');
for (const doc of ['README.md', 'CHANGELOG.md']) {
  if (!listing.includes(`package/${doc}`)) fail(`tarball is missing package/${doc}`);
}

if (process.env.SKIP_GATE === '1') {
  log('SKIP_GATE=1 — skipping global-install smoke');
} else {
  const prefix = path.join(TMP, 'prefix');
  mkdirSync(prefix, { recursive: true });
  log('Global-installing the tarball into a throwaway prefix…');
  run('npm', ['install', '-g', '--prefix', prefix, tarball]);
  const bin = path.join(prefix, 'bin', 'orcaops');
  const ver = capture(bin, ['--version']).trim();
  if (!ver.includes(VERSION))
    fail(`installed orcaops --version printed "${ver}", expected ${VERSION}`);
  log(`Installed CLI reports version ${ver} ✓`);
  // Prove @orcaops/evaluator-pack resolves from the installed CLI root.
  const installedPkgJson = path.join(
    prefix,
    'lib',
    'node_modules',
    '@orcaops',
    'cli',
    'package.json'
  );
  run('node', [
    '-e',
    `const{createRequire}=require('node:module');createRequire(${JSON.stringify(installedPkgJson)}).resolve('@orcaops/evaluator-pack/package.json');console.log('evaluator-pack resolves OK')`,
  ]);

  // The probe is written INTO the installed dist/ so import.meta.resolve runs
  // from the same directory and ESM semantics as dist/cli/index.js. It must not
  // resolve "<pkg>/package.json": several of these packages do not export it.
  const installedCliDir = path.dirname(installedPkgJson);
  const probePath = path.join(installedCliDir, 'dist', '__resolve-probe.mjs');
  writeFileSync(
    probePath,
    [
      `const required = ${JSON.stringify(Object.keys(DIST_DEPENDENCIES))};`,
      `const optional = ${JSON.stringify(Object.keys(DIST_OPTIONAL_DEPENDENCIES))};`,
      // A platform package has no JS entry; its manifest is the resolvable surface.
      `const byManifest = new Set(${JSON.stringify(WATCH_PLATFORM_PACKAGES)});`,
      'const missing = [];',
      'for (const spec of required) {',
      '  try { import.meta.resolve(spec); } catch (err) { missing.push(`${spec}: ${err.code ?? err.message}`); }',
      '}',
      'const absentOptional = [];',
      'for (const spec of optional) {',
      '  const target = byManifest.has(spec) ? `${spec}/package.json` : spec;',
      '  try { import.meta.resolve(target); } catch { absentOptional.push(spec); }',
      '}',
      'if (missing.length > 0) {',
      '  console.error("unresolvable from the installed package:\\n  " + missing.join("\\n  "));',
      '  process.exit(1);',
      '}',
      'const optNote = absentOptional.length > 0 ? `; optional absent: ${absentOptional.join(", ")}` : "";',
      'console.log(`all ${required.length} runtime deps resolve from the installed package${optNote}`);',
    ].join('\n')
  );
  const probeRes = spawnSync('node', [probePath], { cwd: installedCliDir, encoding: 'utf8' });
  rmSync(probePath, { force: true });
  if (probeRes.status !== 0) {
    process.stderr.write(`${probeRes.stdout ?? ''}${probeRes.stderr ?? ''}`);
    fail('install smoke: a runtime dependency does not resolve from the installed package');
  }
  log(`Install smoke: ${probeRes.stdout.trim()} ✓`);

  // The sidecar must run from the installed tree under plain Node: it is what
  // `orcaops watch` hands the compiled UI, and it resolves the proprietary
  // packages from this very node_modules.
  const sidecarRes = spawnSync(
    'node',
    [path.join(installedCliDir, 'dist', 'watch-sidecar.js'), 'review', '--help'],
    { cwd: installedCliDir, encoding: 'utf8' }
  );
  if (sidecarRes.status !== 0 || !sidecarRes.stdout.includes('usage: review')) {
    process.stderr.write(`${sidecarRes.stdout ?? ''}${sidecarRes.stderr ?? ''}`);
    fail(
      'install smoke: dist/watch-sidecar.js does not answer `review --help` from the installed package'
    );
  }
  log('Install smoke: the Watch data sidecar answers from the installed package ✓');
}

// ---------------------------------------------------------------------------
// 10. Report + write a verifiable SHA256SUMS manifest
// ---------------------------------------------------------------------------
const artifacts = [tarball];
const sums = artifacts.map((f) => ({
  file: path.basename(f),
  sha: createHash('sha256').update(readFileSync(f)).digest('hex'),
}));
// Standard `shasum` / `sha256sum` format ("<hash>  <filename>"), verifiable from
// inside dist-release/ with:  shasum -a 256 -c SHA256SUMS  (or `sha256sum -c`).
const sumsPath = path.join(RELEASE, 'SHA256SUMS');
writeFileSync(sumsPath, sums.map((s) => `${s.sha}  ${s.file}`).join('\n') + '\n');

const sizeMb = (statSync(tarball).size / 1024 / 1024).toFixed(2);
log('');
log(`\x1b[32mDONE\x1b[0m  ${path.relative(ROOT, tarball)}  (${sizeMb} MB)`);
for (const s of sums) log(`sha256  ${s.sha}  ${s.file}`);
log(
  `Wrote   ${path.relative(ROOT, sumsPath)}  (verify: cd ${path.relative(ROOT, RELEASE)} && shasum -a 256 -c SHA256SUMS)`
);
log('Distribute the tarball and SHA256SUMS together. To install:');
log(`  npm i -g ./orcaops-cli-${VERSION}.tgz   (docs: https://docs.orcaops.ai)`);

// ---------------------------------------------------------------------------
// THIRD-PARTY-NOTICES generator
// ---------------------------------------------------------------------------
// Two populations: the closure esbuild inlined into dist/cli/index.js, which no
// manifest mentions, and the bundledDependencies installed on disk. The inlined
// half is walked from the real closure because esbuild's legalComments sidecar
// only sees packages that ship an inline banner, and nearly none do.
function generateNotices() {
  const bundled = collectBundledPackages();
  const parts = [
    'orcaops CLI — Third-Party Notices',
    '=================================',
    '',
    'This distribution bundles software from other parties, under a mix of',
    'open-source and proprietary terms. Their license notices are reproduced',
    'below for attribution. The terms differ per package: read each entry.',
    '',
  ];

  parts.push(
    '## Bundled into the CLI (dist/cli/index.js and dist/watch-sidecar.js)',
    '',
    'These packages have no separate presence in the distribution — the bundler',
    'copied their code into dist/cli/index.js or dist/watch-sidecar.js.',
    ''
  );
  const covered = new Set();
  for (const key of [...bundled.keys()].sort()) {
    covered.add(key);
    parts.push(...renderNotice(bundled.get(key)));
  }

  // On-disk closure deps (node_modules) shipped via bundledDependencies.
  parts.push(
    '## Shipped on disk (node_modules)',
    '',
    'Packages already listed above are not repeated here.',
    ''
  );
  for (const pkgDir of enumeratePackages(path.join(STAGING, 'node_modules'))) {
    const meta = readJson(path.join(pkgDir, 'package.json'));
    if (covered.has(`${meta.name}@${meta.version}`)) continue;
    covered.add(`${meta.name}@${meta.version}`);
    parts.push(...renderNotice(pkgDir));
  }

  // Kept as a supplement, not as the source of truth: an inline banner can
  // carry a copyright line that appears in no LICENSE file.
  const legalFiles = [
    path.join(STAGING, 'dist', 'cli', 'index.js.LEGAL.txt'),
    path.join(STAGING, 'dist', 'watch-sidecar.js.LEGAL.txt'),
  ].filter((file) => existsSync(file));
  if (legalFiles.length > 0) {
    parts.push('## Inline license banners preserved from the bundled sources', '');
    for (const legal of legalFiles) parts.push(readFileSync(legal, 'utf8'), '');
  }

  writeFileSync(path.join(STAGING, 'THIRD-PARTY-NOTICES'), parts.join('\n'));
  log(`Generated THIRD-PARTY-NOTICES for ${covered.size} package(s)`);
}

function renderNotice(pkgDir) {
  try {
    return renderNoticeShared(pkgDir, { rootDir: ROOT });
  } catch (error) {
    fail(error.message);
  }
}

// Keyed by name@version, not by name: two versions of the same package can both
// be inlined — they are today — and each needs its own notice.
function collectBundledPackages() {
  try {
    return collectPackages({
      seeds: Object.keys(cliPkg.dependencies ?? {}),
      from: CLI_DIR,
      externals: BUNDLE_EXTERNALS,
      rootDir: ROOT,
    });
  } catch (error) {
    fail(error.message);
  }
}
