#!/usr/bin/env node
// Builds the four @orcaops/watch-<os>-<cpu> platform packages: one compiled
// Task Review UI executable each, licensed, attributed, packed and summed.
// They version with the CLI that pins them and publish in its release run.
//
//   pnpm release:watch-platforms                # compile (needs the pinned Bun) + stage
//   SKIP_COMPILE=1 pnpm release:watch-platforms # stage prebuilt executables (Node only)
//   WATCH_COMPILED_DIR=<dir>                    # where the executables are (CI artifact)
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROPRIETARY_PACKAGES } from './check-no-proprietary.mjs';
import { resolvePackageDir } from './third-party-notices.mjs';
import {
  assertTarball,
  packStaged,
  run,
  stageLicense,
  StagingError,
  verifyStaging,
  writeManifest,
  writeNotices,
  writeSums,
} from './lib/release-staging.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH_DIR = path.join(ROOT, 'apps', 'orcaops-watch');
const CLI_DIR = path.join(ROOT, 'apps', 'orcaops-cli');
const BUILD_DIR = path.join(ROOT, 'build', 'watch-platforms');
const STAGING = path.join(BUILD_DIR, 'staging');
const RELEASE = path.join(ROOT, 'dist-release');
const EXE = 'bin/orcaops-watch-ui';
// The executable prints this on --selfcheck; its presence proves the byte
// scan below actually saw the bundled JavaScript.
const POSITIVE_CONTROL = 'watch selfcheck ok';

function log(msg) {
  process.stdout.write(`\x1b[36m[release:watch-platforms]\x1b[0m ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\x1b[31m[release:watch-platforms] ERROR:\x1b[0m ${msg}\n`);
  process.exit(1);
}
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

try {
  const cliPkg = readJson(path.join(CLI_DIR, 'package.json'));
  const watchPkg = readJson(path.join(WATCH_DIR, 'package.json'));
  const VERSION = cliPkg.version;
  const pinnedBun = readFileSync(path.join(ROOT, '.bun-version'), 'utf8').trim();
  const platforms = readJson(path.join(WATCH_DIR, 'platforms.json'));
  log(`platform packages for @orcaops/cli@${VERSION} (Bun ${pinnedBun})`);

  // -------------------------------------------------------------------------
  // 1. Compile (or take prebuilt executables) and check the declaration
  // -------------------------------------------------------------------------
  const compiledDir = process.env.WATCH_COMPILED_DIR ?? path.join(WATCH_DIR, 'build', 'compiled');
  if (process.env.SKIP_COMPILE === '1') {
    log(`SKIP_COMPILE=1 — using executables under ${path.relative(ROOT, compiledDir)}`);
  } else {
    log('Compiling the Watch UI for every platform (pnpm --filter @orcaops/watch compile)…');
    run('pnpm', ['--filter', '@orcaops/watch', 'compile'], { cwd: ROOT, stdio: 'inherit' });
  }
  const declarationFile = path.join(compiledDir, '.compile-externals.json');
  if (!existsSync(declarationFile))
    fail(`no compile declaration at ${declarationFile} — compile first`);
  const declaration = readJson(declarationFile);
  if (declaration.version !== VERSION) {
    fail(`the executables were compiled for ${declaration.version}, not @orcaops/cli@${VERSION}`);
  }
  if (declaration.bun !== pinnedBun) {
    fail(`the executables embed Bun ${declaration.bun}, but .bun-version pins ${pinnedBun}`);
  }
  const executables = platforms.map((platform) => ({
    platform,
    exe: path.join(compiledDir, platform.package, platform.exe),
  }));
  for (const { platform, exe } of executables) {
    if (!existsSync(exe)) fail(`missing executable for ${platform.package}: ${exe}`);
  }

  // -------------------------------------------------------------------------
  // 2. Licence gate on every executable: declaration + bytes + positive control
  // -------------------------------------------------------------------------
  log('Checking every executable for inlined proprietary code…');
  run(
    'node',
    [
      path.join(ROOT, 'scripts', 'check-no-proprietary.mjs'),
      `--externals-from=${declarationFile}`,
      ...executables.map((e) => e.exe),
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  for (const { platform, exe } of executables) {
    if (!readFileSync(exe, 'latin1').includes(POSITIVE_CONTROL)) {
      fail(
        `${platform.package}: the byte scan cannot see the bundled JavaScript (no "${POSITIVE_CONTROL}")`
      );
    }
  }
  log('Executables keep the proprietary packages external, and the scan saw their code ✓');

  // -------------------------------------------------------------------------
  // 3. Stage, attribute, pack and verify one package per platform
  // -------------------------------------------------------------------------
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(RELEASE, { recursive: true });
  for (const stale of readdirSync(RELEASE)) {
    if (/^orcaops-watch-.*\.tgz$/.test(stale)) rmSync(path.join(RELEASE, stale));
  }

  // A Bun compile exposes no module graph, so the attribution walk starts from
  // a superset of what the UI can inline: the app's runtime deps and every
  // workspace package it declares, minus what stays external at run time.
  const workspaceSeeds = Object.keys(watchPkg.devDependencies ?? {}).filter(
    (name) =>
      name.startsWith('@orcaops/') &&
      (watchPkg.devDependencies[name] ?? '').startsWith('workspace:')
  );
  const runtimeSeeds = Object.keys(watchPkg.dependencies ?? {});
  const externals = [...PROPRIETARY_PACKAGES, 'better-sqlite3', '@napi-rs/keyring'];

  const tarballs = [];
  for (const { platform, exe } of executables) {
    const dir = path.join(STAGING, platform.package.replace('/', '+'));
    mkdirSync(path.join(dir, 'bin'), { recursive: true });
    copyFileSync(exe, path.join(dir, EXE));
    chmodSync(path.join(dir, EXE), 0o755);
    stageLicense(dir, { rootDir: ROOT });

    // The native library is an optional dependency of @opentui/core, installed
    // beside core's real directory rather than under the app.
    const opentuiCore = resolvePackageDir('@opentui/core', WATCH_DIR);
    if (opentuiCore === null) fail('cannot resolve @opentui/core from the watch app');
    const nativeLib = { name: `@opentui/core-${platform.os}-${platform.cpu}`, from: opentuiCore };
    const attributed = writeNotices(dir, {
      title: `${platform.package} — Third-Party Notices`,
      intro: [
        `This package is the Task Review terminal UI of Orcaops compiled for ${platform.os}-${platform.cpu}`,
        `as a single-file executable. The executable embeds the Bun ${pinnedBun} runtime and the`,
        'JavaScript packages listed below. The proprietary Orcaops packages (' +
          PROPRIETARY_PACKAGES.join(', ') +
          ')',
        'are NOT embedded: the executable loads them at run time from the @orcaops/cli',
        'installation that launches it, under their own terms.',
      ],
      seeds: [...runtimeSeeds, ...workspaceSeeds, nativeLib],
      from: WATCH_DIR,
      externals,
      rootDir: ROOT,
      runtimes: [
        {
          name: 'bun',
          version: pinnedBun,
          license: 'MIT, with statically linked components under their own terms',
          note:
            'Bun is the JavaScript runtime this executable embeds. Its notice below covers the ' +
            'runtime and the libraries it statically links (including JavaScriptCore under LGPL-2).',
        },
      ],
    });
    const notices = readFileSync(path.join(dir, 'THIRD-PARTY-NOTICES'), 'utf8');
    if (/UNKNOWN/.test(notices))
      fail(`${platform.package}: THIRD-PARTY-NOTICES carries an UNKNOWN entry`);

    writeManifest(dir, {
      name: platform.package,
      version: VERSION,
      description: `Orcaops Task Review UI compiled for ${platform.os}-${platform.cpu}; installed by @orcaops/cli.`,
      license: 'FSL-1.1-ALv2',
      repository: { ...watchPkg.repository },
      os: [platform.os],
      cpu: [platform.cpu],
      ...(platform.libc ? { libc: [platform.libc] } : {}),
      // No JavaScript entry: the manifest is the only thing a resolver needs.
      exports: { '.': './package.json', './package.json': './package.json' },
      files: ['bin', 'LICENSE', 'THIRD-PARTY-NOTICES'],
      publishConfig: { access: 'public' },
      orcaopsWatch: { exe: EXE, bun: pinnedBun, target: platform.target },
    });

    verifyStaging(dir, {
      rootDir: ROOT,
      bundle: EXE,
      executable: EXE,
      codesign: platform.os === 'darwin',
    });

    const tarball = packStaged(dir, RELEASE);
    assertTarball(tarball, {
      required: [
        'package/package.json',
        'package/LICENSE',
        'package/THIRD-PARTY-NOTICES',
        `package/${EXE}`,
      ],
      forbid: /\.(map|ts|tsx)$/,
      executable: [`package/${EXE}`],
    });
    tarballs.push(tarball);
    log(`${platform.package}: ${attributed} notices, ${path.basename(tarball)} ✓`);
  }

  // -------------------------------------------------------------------------
  // 4. Sums: sha256 for humans, sha512 SRI for the registry comparison
  // -------------------------------------------------------------------------
  writeSums(RELEASE, tarballs, { sha256File: 'SHA256SUMS-watch', sha512File: 'SHA512SUMS-watch' });
  log(`Wrote SHA256SUMS-watch and SHA512SUMS-watch for ${tarballs.length} tarball(s)`);
  log(`\x1b[32mDONE\x1b[0m  ${tarballs.map((t) => path.basename(t)).join('  ')}`);
} catch (error) {
  if (error instanceof StagingError) fail(error.message);
  throw error;
}
