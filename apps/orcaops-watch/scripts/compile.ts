#!/usr/bin/env bun
// Compiles the OpenTUI UI into one single-file executable per platform
// (build/compiled/<package>/bin/orcaops-watch-ui). OpenTUI, React and the
// FSL workspace code are bundled; the three proprietary packages are NOT —
// every import of them is rewritten into a shim that require()s the real
// package at run time from the @orcaops/cli install that launched the UI.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import platforms from '../platforms.json';

interface Platform {
  package: string;
  os: string;
  cpu: string;
  libc?: string;
  target: string;
  exe: string;
}

const APP = path.resolve(import.meta.dir, '..');
const REPO = path.resolve(APP, '..', '..');
const OUT = path.join(APP, 'build', 'compiled');
const ENTRY = path.join(APP, 'src', 'entry.ts');

const PROPRIETARY = ['@orcaops/protocol', '@orcaops/sdk', '@orcaops/diff-fingerprint'] as const;
// Subpaths too: diff-fingerprint exports ./fixtures, and the licence gate
// counts `pkg/…` specifiers as the package.
const PROPRIETARY_FILTER = /^@orcaops\/(protocol|sdk|diff-fingerprint)(\/|$)/;

function fail(message: string): never {
  console.error(`[compile] ${message}`);
  process.exit(1);
}

// The executable embeds this Bun; a compile on any other version ships an
// untested runtime, so the pin is a hard precondition rather than a warning.
const pinnedBun = readFileSync(path.join(REPO, '.bun-version'), 'utf8').trim();
if (Bun.version !== pinnedBun) {
  fail(
    `Bun ${Bun.version} is running but .bun-version pins ${pinnedBun} — install the pinned Bun first`
  );
}

// Platform packages are versioned with the CLI that pins them.
const cliManifest = JSON.parse(
  readFileSync(path.join(REPO, 'apps', 'orcaops-cli', 'package.json'), 'utf8')
) as { name: string; version: string };
const version = cliManifest.version;

function selectedPlatforms(): Platform[] {
  const all = platforms as Platform[];
  const selection = process.env.ORCAOPS_WATCH_TARGETS ?? 'all';
  if (selection === 'all') return all;
  if (selection === 'host') {
    const host = all.find((p) => p.os === process.platform && p.cpu === process.arch);
    if (host === undefined)
      fail(`no compile target for this host (${process.platform}-${process.arch})`);
    return [host];
  }
  fail(`ORCAOPS_WATCH_TARGETS must be "all" or "host", got "${selection}"`);
}

// A proprietary import becomes a CommonJS shim. At run time the shim reads the
// launching CLI's package.json, refuses anything but @orcaops/cli at the very
// version this executable was built for (a stale export or a second CLI
// install would otherwise pair mismatched proprietary versions), then
// require()s the package from that CLI's node_modules.
function runtimeShim(specifier: string): string {
  return [
    `const { createRequire } = require('node:module');`,
    `const root = process.env.ORCAOPS_WATCH_DEPS_ROOT;`,
    `if (!root) throw new Error('ORCAOPS_WATCH_DEPS_ROOT is not set: launch the Task Review UI through \`orcaops watch\`');`,
    `const req = createRequire(root + '/package.json');`,
    `const manifest = req('./package.json');`,
    `if (manifest.name !== '@orcaops/cli' || manifest.version !== ${JSON.stringify(version)}) {`,
    `  throw new Error('this Task Review UI was built for @orcaops/cli@${version} but ORCAOPS_WATCH_DEPS_ROOT holds ' + manifest.name + '@' + manifest.version);`,
    `}`,
    `module.exports = req(${JSON.stringify(specifier)});`,
    '',
  ].join('\n');
}

async function compile(platform: Platform): Promise<string> {
  const outfile = path.join(OUT, platform.package, platform.exe);
  mkdirSync(path.dirname(outfile), { recursive: true });
  const rewrites = new Map<string, number>();

  const result = await Bun.build({
    entrypoints: [ENTRY],
    compile: {
      target: platform.target as Bun.Build.CompileTarget,
      outfile,
      // The executable must resolve the proprietary packages from the CLI's
      // node_modules by their package.json main/exports; standalone Bun
      // executables skip package.json at run time unless asked (deliberate
      // since Bun 1.3.4, oven-sh/bun#27058).
      autoloadPackageJson: true,
      // Never let the user's cwd change the UI's environment or preload code.
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
    },
    define: { 'process.env.ORCAOPS_WATCH_BUILD_VERSION': JSON.stringify(version) },
    plugins: [
      {
        name: 'orcaops-proprietary-runtime-load',
        setup(build) {
          build.onResolve({ filter: PROPRIETARY_FILTER }, (args) => {
            rewrites.set(args.path, (rewrites.get(args.path) ?? 0) + 1);
            return { path: args.path, namespace: 'orcaops-runtime-dep' };
          });
          build.onLoad({ filter: /.*/, namespace: 'orcaops-runtime-dep' }, (args) => ({
            loader: 'js',
            contents: runtimeShim(args.path),
          }));
        },
      },
    ],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    fail(`${platform.target}: bundle failed`);
  }

  // A package that was never rewritten was either dropped by tree shaking or
  // inlined by a path the plugin did not see; only the first is acceptable,
  // and the licence gate cannot tell them apart from the bytes alone.
  for (const pkg of PROPRIETARY) {
    const count = [...rewrites.entries()]
      .filter(([spec]) => spec === pkg || spec.startsWith(`${pkg}/`))
      .reduce((sum, [, n]) => sum + n, 0);
    if (count === 0)
      fail(`${platform.target}: no import of ${pkg} was rewritten to a runtime shim`);
  }

  chmodSync(outfile, 0o755);
  if (platform.os === 'darwin') resign(outfile);

  const rewritten = [...rewrites.entries()].map(([spec, n]) => `${spec}×${n}`).join(', ');
  console.log(`compiled ${platform.target} → ${path.relative(APP, outfile)} (${rewritten})`);
  return outfile;
}

// Bun's ad-hoc signature does not verify (oven-sh/bun#32159; Apple silicon
// refuses unsigned native code and macOS 27 kills an invalid signature), so
// re-sign in place and prove it. Only a mac can sign; anywhere else the
// release job on macos-15 is the gate.
function resign(exe: string): void {
  if (Bun.which('codesign') === null) {
    console.warn(
      `[compile] codesign unavailable on this host; ${path.basename(path.dirname(path.dirname(exe)))} left with Bun's signature`
    );
    return;
  }
  const sign = Bun.spawnSync(['codesign', '-s', '-', '-f', exe], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (sign.exitCode !== 0) fail(`codesign -s - failed: ${sign.stderr.toString()}`);
  const verify = Bun.spawnSync(['codesign', '--verify', '--strict', '--verbose=2', exe], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (verify.exitCode !== 0)
    fail(`codesign --verify failed after re-sign: ${verify.stderr.toString()}`);
}

const built: string[] = [];
for (const platform of selectedPlatforms()) built.push(await compile(platform));

// The licence gate has no module graph for a Bun compile, so it verifies this
// declaration plus the bytes. Written by the build so it cannot drift.
writeFileSync(
  path.join(OUT, '.compile-externals.json'),
  JSON.stringify({ external: [...PROPRIETARY], version, bun: pinnedBun }, null, 2) + '\n'
);
if (!existsSync(path.join(OUT, '.compile-externals.json')))
  fail('externals declaration not written');
console.log(
  `compiled ${built.length} executable(s) for @orcaops/cli@${version} with Bun ${pinnedBun}`
);
