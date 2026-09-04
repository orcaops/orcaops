#!/usr/bin/env node
// Publishes the four @orcaops/watch-<os>-<cpu> platform packages from one
// artifact set, all or nothing, and proves the registry holds those bytes.
//
//   node scripts/publish-platforms.mjs [--release-dir <dir>] [--registry <url>]
//                                      [--dry-run] [--token-env NPM_BOOTSTRAP_TOKEN]
//
// In CI no token exists (trusted publishing only); --token-env serves the
// maintainer's local bootstrap ceremony (documented in the private release
// runbook), which creates a brand-new name before its trusted publisher can
// be registered.
//
// Bun compiles are not byte-reproducible, so a version that is partly on the
// registry can never be completed from a DIFFERENT compile: whatever is
// already present must carry exactly this artifact set's integrity, in which
// case the missing packages are published from the same tarballs; a mismatch
// means the version is spent — bump it. Trusted publishing (OIDC) cannot
// create a name npm has never seen, so a name with no versions at all is
// published with the token named by --token-env, when one is set.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { distTagFor } from './release-channel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}
const releaseDir = path.resolve(flag('--release-dir', path.join(ROOT, 'dist-release')));
const registry = (flag('--registry', DEFAULT_REGISTRY) ?? DEFAULT_REGISTRY).replace(/\/$/, '');
const dryRun = args.includes('--dry-run');
const tokenEnv = flag('--token-env', 'NPM_BOOTSTRAP_TOKEN');
const provenance = registry === DEFAULT_REGISTRY;

function log(msg) {
  process.stdout.write(`\x1b[36m[publish-platforms]\x1b[0m ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\x1b[31m[publish-platforms] ERROR:\x1b[0m ${msg}\n`);
  process.exit(1);
}
function npm(argv, opts = {}) {
  return spawnSync('npm', [...argv, '--registry', registry], { encoding: 'utf8', ...opts });
}
function sri(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

// The tarballs and the sums the builder wrote for them.
const sumsFile = path.join(releaseDir, 'SHA512SUMS-watch');
if (!existsSync(sumsFile)) {
  fail(`no SHA512SUMS-watch in ${releaseDir} — run pnpm release:watch-platforms first`);
}
const sums = new Map(
  readFileSync(sumsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [integrity, name] = line.trim().split(/\s+/);
      return [name, integrity];
    })
);
const packages = readdirSync(releaseDir)
  .filter((f) => /^orcaops-watch-.*\.tgz$/.test(f))
  .map((file) => {
    const tarball = path.join(releaseDir, file);
    const manifest = JSON.parse(
      spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout
    );
    const local = sri(tarball);
    if (sums.get(file) !== local)
      fail(`${file} no longer matches SHA512SUMS-watch — rebuild the release`);
    return { file, tarball, name: manifest.name, version: manifest.version, integrity: local };
  });
if (packages.length !== 4)
  fail(`expected 4 platform tarballs in ${releaseDir}, found ${packages.length}`);
const version = packages[0].version;
if (packages.some((p) => p.version !== version))
  fail('the platform tarballs carry different versions');
// Counting four is not enough: four tarballs can carry three distinct names,
// which would silently strand one platform's users on a published CLI.
const expectedNames = new Set(
  JSON.parse(readFileSync(path.join(ROOT, 'apps', 'orcaops-watch', 'platforms.json'), 'utf8')).map(
    (t) => t.package
  )
);
const actualNames = new Set(packages.map((p) => p.name));
if (
  actualNames.size !== expectedNames.size ||
  [...expectedNames].some((n) => !actualNames.has(n))
) {
  fail(
    `the tarballs do not cover every platform: expected ${[...expectedNames].sort().join(', ')}, ` +
      `found ${[...actualNames].sort().join(', ')}`
  );
}
// The CLI pins these at its own version, so a skew publishes companions no
// released CLI can resolve — and npm skips an unresolvable optional silently.
const expectVersion = flag('--expect-version');
if (expectVersion !== null && expectVersion !== version) {
  fail(`the platform tarballs are ${version} but the release is ${expectVersion}`);
}
log(
  `${packages.length} platform packages at ${version} → ${registry}${dryRun ? ' (dry run)' : ''}`
);

// What the registry already holds.
function registryIntegrity(name) {
  const res = npm(['view', `${name}@${version}`, 'dist.integrity', '--json']);
  if (res.status !== 0) {
    // "not published" is E404. Anything else — a 5xx, a rate limit, a network
    // blip — must NOT read as "absent", or the spent-version guard below is
    // skipped for a package that is in fact already on the registry.
    const err = `${res.stdout}${res.stderr}`;
    if (/E404|404 Not Found|is not in this registry/i.test(err)) return null;
    fail(`could not read ${name}@${version} from the registry: ${err.trim().slice(0, 300)}`);
  }
  const out = res.stdout.trim();
  if (out === '') return null;
  return JSON.parse(out);
}
function nameKnown(name) {
  const res = npm(['view', name, 'name', '--json']);
  return res.status === 0 && res.stdout.trim() !== '';
}

const present = packages.map((p) => ({ ...p, registry: registryIntegrity(p.name) }));
for (const p of present) {
  if (p.registry !== null && p.registry !== p.integrity) {
    fail(
      `${p.name}@${version} is on the registry with integrity ${p.registry}, not this artifact's ` +
        `${p.integrity}; the version is spent — bump it and publish all four from one compile`
    );
  }
}
const pending = present.filter((p) => p.registry === null);
const count = packages.length - pending.length;
if (pending.length === 0) {
  log(`all ${count} already published with matching integrity — nothing to publish ✓`);
  process.exit(0);
}
if (count !== 0) {
  log(
    `${count} of ${packages.length} already published with matching integrity; completing the set from the same artifacts`
  );
}

// Auth per package: OIDC for known names, the bootstrap token for unknown ones.
const token = tokenEnv ? process.env[tokenEnv] : undefined;
const userconfigDir = mkdtempSync(path.join(tmpdir(), 'publish-platforms-'));
const userconfig = path.join(userconfigDir, 'npmrc');
const host = registry.replace(/^https?:/, '');
// npm expands ${VAR} in npmrc, so the token never appears in argv or logs.
writeFileSync(userconfig, `${host}/:_authToken=\${${tokenEnv}}\n`);

const plan = pending.map((p) => ({ ...p, known: nameKnown(p.name) }));
const needsToken = plan.filter((p) => !p.known);
// Deliberately NOT skipped under --dry-run: the rehearsal exists to catch a
// missed name bootstrap, and skipping it here made a green dry run compatible
// with none of the four names existing.
if (needsToken.length > 0 && !token) {
  fail(
    `${needsToken.map((p) => p.name).join(', ')} ${needsToken.length === 1 ? 'is' : 'are'} unknown to ` +
      `the registry; the first publish of a name needs the bootstrap token in $${tokenEnv} (trusted ` +
      `publishing cannot create a name)`
  );
}
for (const p of plan) {
  log(
    `${p.name}@${version}: ${p.known ? 'known name (trusted publishing)' : 'new name (bootstrap token)'}`
  );
}

try {
  for (const p of plan) {
    // npm refuses a prerelease with no tag rather than defaulting it to latest,
    // and the same helper decides the CLI's tag, so the packages it pins land
    // beside it instead of under a second answer.
    const argv = ['publish', p.tarball, '--access', 'public', '--tag', distTagFor(version)];
    // Only a known name can carry provenance. A first publish runs from a
    // laptop against the bootstrap token, and npm generates provenance only
    // inside a supported CI with an OIDC token — asking anyway fails the very
    // ceremony that creates the name, and --provenance overrides the
    // NPM_CONFIG_PROVENANCE=false the runbook sets.
    if (provenance && p.known) argv.push('--provenance');
    if (dryRun) argv.push('--dry-run');
    if (!p.known) argv.push('--userconfig', userconfig);
    const res = npm(argv, { stdio: 'inherit', env: process.env });
    if (res.status !== 0) fail(`npm publish failed for ${p.name}@${version} (exit ${res.status})`);
  }
} finally {
  rmSync(userconfigDir, { recursive: true, force: true });
}
if (dryRun) {
  log(`dry run: would have published all ${plan.length} ✓`);
  process.exit(0);
}

// The registry must now hold exactly these bytes: the recorded integrity and
// a fresh download both have to match the artifact. A just-published version
// can stay invisible behind the registry's CDN for a while, so wait for it.
const VERIFY_WINDOW_MS = 4 * 60 * 1000;
const VERIFY_STEP_MS = 10 * 1000;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function awaitIntegrity(name) {
  const deadline = Date.now() + VERIFY_WINDOW_MS;
  for (;;) {
    const recorded = registryIntegrity(name);
    if (recorded !== null) return recorded;
    if (Date.now() >= deadline) return null;
    log(`${name}@${version} not visible yet; retrying in ${VERIFY_STEP_MS / 1000}s`);
    await sleep(VERIFY_STEP_MS);
  }
}
const downloads = mkdtempSync(path.join(tmpdir(), 'publish-platforms-verify-'));
try {
  for (const p of plan) {
    const recorded = await awaitIntegrity(p.name);
    if (recorded !== p.integrity)
      fail(`${p.name}@${version}: registry integrity ${recorded} ≠ artifact ${p.integrity}`);
    const packed = npm([
      'pack',
      `${p.name}@${version}`,
      '--pack-destination',
      downloads,
      '--json',
      '--prefer-online',
    ]);
    if (packed.status !== 0) fail(`could not re-download ${p.name}@${version}: ${packed.stderr}`);
    const [info] = JSON.parse(packed.stdout);
    const downloaded = sri(path.join(downloads, info.filename));
    if (downloaded !== p.integrity)
      fail(`${p.name}@${version}: downloaded bytes ${downloaded} ≠ artifact ${p.integrity}`);
    log(`${p.name}@${version}: registry integrity and re-downloaded bytes match ✓`);
  }
} finally {
  rmSync(downloads, { recursive: true, force: true });
}
log(`published all ${plan.length} platform packages at ${version} ✓`);
