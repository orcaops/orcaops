// Staging toolkit shared by the release builders: one package directory in,
// a licensed, attributed, packed, verified tarball out. Each helper does one
// thing and fails loudly; the builders compose them per package.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  collectPackages,
  readSupplementalNotice,
  renderNotice,
  SUPPLEMENTAL_DIR,
} from '../third-party-notices.mjs';

export class StagingError extends Error {}

function fail(message) {
  throw new StagingError(message);
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    fail(`\`${cmd} ${args.join(' ')}\` exited ${res.status ?? res.signal}\n${res.stderr ?? ''}`);
  }
  return res.stdout;
}

/** The repository LICENSE, verbatim: it is what turns staged bytes into a grant. */
export function stageLicense(stagingDir, { rootDir }) {
  const source = path.join(rootDir, 'LICENSE');
  if (!existsSync(source)) fail(`no LICENSE at ${source}; refusing to stage an unlicensed package`);
  copyFileSync(source, path.join(stagingDir, 'LICENSE'));
}

/**
 * THIRD-PARTY-NOTICES for a package whose contents were bundled: the closure is
 * walked from `seeds` (skipping `externals`) because a compiled artefact carries
 * no manifest that names what it inlined. `runtimes` are vendored directories
 * under third-party-notices/ for software that is not an npm package at all
 * (the Bun runtime a compiled executable embeds).
 */
export function writeNotices(
  stagingDir,
  { title, intro, seeds, from, externals = [], rootDir, runtimes = [] }
) {
  const bundled = collectPackages({ seeds, from, externals, rootDir });
  const parts = [title, '='.repeat(title.length), '', ...intro, ''];
  parts.push('## Bundled into this package', '');
  for (const key of [...bundled.keys()].sort()) {
    parts.push(...renderNotice(bundled.get(key), { rootDir }));
  }
  if (runtimes.length > 0) {
    parts.push('## Embedded runtime', '');
    for (const { name, version, license, note } of runtimes) {
      const notice = readSupplementalNotice(path.join(rootDir, SUPPLEMENTAL_DIR), name, version);
      if (notice === null) {
        fail(
          `no vendored notice for ${name}@${version} under ${SUPPLEMENTAL_DIR}/ — the embedded ` +
            `runtime cannot ship unattributed`
        );
      }
      parts.push(`### ${name}@${version} — ${license}`, '', note, '', notice.text, '');
    }
  }
  writeFileSync(path.join(stagingDir, 'THIRD-PARTY-NOTICES'), parts.join('\n'));
  return bundled.size + runtimes.length;
}

const NON_REGISTRY = /^(workspace:|file:|link:|portal:)/;

/** Writes the manifest and refuses any specifier that cannot install from a registry. */
export function writeManifest(stagingDir, manifest) {
  const bad = Object.entries({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  }).filter(([, spec]) => NON_REGISTRY.test(spec));
  if (bad.length > 0) {
    fail(
      `the staged manifest for ${manifest.name} carries ${bad.length} non-registry specifier(s):\n` +
        bad.map(([n, s]) => `    ${n}: ${s}`).join('\n')
    );
  }
  writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

/** `npm pack` from inside staging; returns the tarball path npm reports. */
export function packStaged(stagingDir, releaseDir) {
  const out = run('npm', ['pack', '--pack-destination', releaseDir, '--json'], {
    cwd: stagingDir,
  });
  const [info] = JSON.parse(out);
  const tarball = path.join(releaseDir, info.filename);
  if (!existsSync(tarball)) fail(`npm pack reported ${info.filename} but it is not in ${releaseDir}`);
  return tarball;
}

/** `tar -tvzf` parsed: `{ mode, path }` per entry. */
export function listTarball(tarball) {
  return run('tar', ['-tvzf', tarball])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const columns = line.trim().split(/\s+/);
      return { mode: columns[0], path: columns[columns.length - 1] };
    });
}

/**
 * Assert what the tarball must and must not carry. `executable` entries must
 * keep their execute bits through pack: a lost bit is a broken install.
 */
export function assertTarball(tarball, { required = [], forbid = null, executable = [] }) {
  const entries = listTarball(tarball);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const entry of required) {
    if (!byPath.has(entry)) fail(`${path.basename(tarball)} is missing ${entry}`);
  }
  if (forbid !== null) {
    const leaked = entries.filter((e) => forbid.test(e.path));
    if (leaked.length > 0) {
      fail(
        `${path.basename(tarball)} ships ${leaked.length} forbidden entr${leaked.length === 1 ? 'y' : 'ies'}:\n` +
          leaked
            .slice(0, 20)
            .map((e) => `    ${e.path}`)
            .join('\n')
      );
    }
  }
  for (const entry of executable) {
    const found = byPath.get(entry);
    if (found === undefined) fail(`${path.basename(tarball)} is missing ${entry}`);
    if (!/^-..x..x..x/.test(found.mode)) {
      fail(`${entry} in ${path.basename(tarball)} is not executable (mode ${found.mode})`);
    }
  }
  return entries;
}

/**
 * The publishable-staging verifier plus what it cannot see: the executable's
 * mode on disk and, on macOS, that its signature verifies.
 */
export function verifyStaging(stagingDir, { rootDir, bundle, executable = null, codesign = false }) {
  run(
    'node',
    // --no-docs: a platform package ships one compiled binary and its notices;
    // the README and changelog belong to the CLI these companions serve.
    [
      path.join(rootDir, 'scripts', 'verify-publishable.mjs'),
      stagingDir,
      `--bundle=${bundle}`,
      '--no-docs',
    ],
    { cwd: rootDir }
  );
  if (executable !== null) {
    const exe = path.join(stagingDir, executable);
    if ((statSync(exe).mode & 0o111) === 0) fail(`${executable} is not executable in ${stagingDir}`);
    // Only a mac can verify a Mach-O signature, and only darwin executables carry one.
    if (codesign && process.platform === 'darwin') {
      run('codesign', ['--verify', '--strict', '--verbose=2', exe]);
    }
  }
}

function digest(file, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

/**
 * Two sum files: sha256 hex for humans (`shasum -c`), and sha512 as SRI, which
 * is what npm records as `dist.integrity` for a published tarball and what a
 * release job compares against the registry.
 */
export function writeSums(releaseDir, tarballs, { sha256File, sha512File }) {
  const names = tarballs.map((t) => path.basename(t));
  writeFileSync(
    path.join(releaseDir, sha256File),
    tarballs.map((t, i) => `${digest(t, 'sha256', 'hex')}  ${names[i]}`).join('\n') + '\n'
  );
  writeFileSync(
    path.join(releaseDir, sha512File),
    tarballs.map((t, i) => `sha512-${digest(t, 'sha512', 'base64')}  ${names[i]}`).join('\n') + '\n'
  );
}
