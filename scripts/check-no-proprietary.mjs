#!/usr/bin/env node
// Fail if a proprietary package's bytes ended up inside a built bundle.
//
// The specifier check is primary and the marker scan secondary, never the other
// way round: a bundler drops every literal on an unreached code path, so a
// bundle holding only @orcaops/sdk's wire layer trips none of the sdk markers.
//
// Markers are literals, not symbol names — the vendored dists ship minified —
// and each must be absent from first-party src/. CloudWireError, DiscoveryError
// and TrpcRequestError are excluded for that reason.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PROPRIETARY_PACKAGES = [
  '@orcaops/protocol',
  '@orcaops/sdk',
  '@orcaops/diff-fingerprint',
];

export const MARKERS = {
  '@orcaops/protocol': [
    'done_criteria criterion text must not be blank',
    'missing_close_tree_sha',
    'diff_fingerprint is required when diff_fingerprint_summary.manifest_hash is non-null',
    'A reply inherits the parent target; do not set a target_version_id / proposal.',
    'author and author_me are mutually exclusive.',
  ],
  '@orcaops/sdk': [
    'TokenExchangeError',
    'JwtDecodeError',
    'Cannot refresh: no credentials in store.',
    'credential_read_failed',
  ],
  '@orcaops/diff-fingerprint': [
    'blake3-xof-96-base64url-nopad-v1',
    'orcaops.diff_fingerprint.line.v1',
    'orcaops.diff_fingerprint.manifest.v1',
    'is out of u32 range',
    'CanonicalizeError',
  ],
};

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

// Probed on the filesystem: these packages do not export "./package.json", so
// require.resolve throws even when installed. Every workspace member is an
// anchor because pnpm installs under the dependent, not at the root.
function installAnchors(repoRoot) {
  const anchors = [repoRoot];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(repoRoot, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) anchors.push(path.join(dir, entry.name));
    }
  }
  return anchors;
}

function findPackageRoot(pkg, repoRoot) {
  for (const anchor of installAnchors(repoRoot)) {
    const candidate = path.join(anchor, 'node_modules', ...pkg.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  const store = path.join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(store)) return null;
  for (const entry of readdirSync(store)) {
    const candidate = path.join(store, entry, 'node_modules', ...pkg.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function packageCode(pkg, repoRoot) {
  const root = findPackageRoot(pkg, repoRoot);
  if (root === null) return null;
  let code = '';
  for (const file of walk(root)) {
    if (/\.(js|mjs|cjs)$/.test(file)) code += readFileSync(file, 'utf8');
  }
  return code;
}

// Only a module-specifier position counts: a bare mention of the name in
// ordinary data is not an import, so it is not evidence of externalization.
function specifierPattern(pkg) {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*(['"\`])${escaped}(?:/[^'"\`]*)?\\1`,
    'g'
  );
}

function countSpecifiers(code, pkg) {
  return (code.match(specifierPattern(pkg)) ?? []).length;
}

export function checkNoProprietary({
  bundles,
  packages = PROPRIETARY_PACKAGES,
  repoRoot = ROOT,
  validateMarkers = true,
  declaredExternals = null,
  metafileInputs = null,
  allowBytesOnly = false,
} = {}) {
  const errors = [];
  const notes = [];

  if (!Array.isArray(bundles) || bundles.length === 0) {
    return { ok: false, errors: ['no bundles given to verify'], notes };
  }

  const haveEvidence = declaredExternals !== null || metafileInputs !== null;
  if (!haveEvidence && !allowBytesOnly) {
    return {
      ok: false,
      errors: [
        'no authoritative evidence supplied: pass declaredExternals (what the build marked ' +
          'external) or metafileInputs (what the bundler actually included). Pass ' +
          'allowBytesOnly for a shipped-bytes re-check, which can only scan for markers ' +
          'and cannot prove externality on its own.',
      ],
      notes,
    };
  }

  if (declaredExternals !== null) {
    const missing = packages.filter((pkg) => !declaredExternals.includes(pkg));
    if (missing.length > 0) {
      errors.push(
        `the build did not declare ${missing.join(', ')} external, so ${
          missing.length === 1 ? 'its bytes were' : 'their bytes were'
        } bundled in.`
      );
    } else {
      notes.push(`build declares all ${packages.length} proprietary package(s) external ✓`);
    }
  }

  // Bun.build returns only { outputs, success, logs } and emits no metafile,
  // which is why the declaration above is what carries the watch app.
  if (metafileInputs !== null) {
    const paths = Array.isArray(metafileInputs) ? metafileInputs : Object.keys(metafileInputs);
    const bundledIn = packages.filter((pkg) =>
      paths.some((f) => f.includes(`node_modules/${pkg}/`) || f.includes(`/${pkg}/dist/`))
    );
    if (bundledIn.length > 0) {
      errors.push(
        `the bundler's module graph lists ${bundledIn.join(', ')} among its inputs, so ` +
          `${bundledIn.length === 1 ? 'its code was' : 'their code was'} copied into the bundle.`
      );
    } else {
      notes.push(`module graph confirms no proprietary package was bundled ✓`);
    }
  }

  if (validateMarkers) {
    let validated = 0;
    for (const pkg of packages) {
      const markers = MARKERS[pkg] ?? [];
      if (markers.length === 0) continue;
      const code = packageCode(pkg, repoRoot);
      if (code === null) {
        errors.push(
          `${pkg} is not resolvable from ${path.relative(process.cwd(), repoRoot) || '.'}, so its ` +
            `markers cannot be validated. This gate refuses to pass vacuously — install the ` +
            `workspace and re-run.`
        );
        continue;
      }
      for (const marker of markers) {
        if (code.includes(marker)) {
          validated++;
        } else {
          errors.push(
            `marker ${JSON.stringify(marker)} no longer appears in ${pkg}. It has rotted and ` +
              `proves nothing — replace it with a literal that is unique to ${pkg} and absent ` +
              `from this repo's first-party src/.`
          );
        }
      }
    }
    if (errors.length > 0) return { ok: false, errors, notes };
    notes.push(`${validated} markers validated against the installed proprietary packages ✓`);
  }

  for (const bundle of bundles) {
    if (!existsSync(bundle)) {
      errors.push(`bundle not found: ${bundle}`);
      continue;
    }
    const inside = path.relative(repoRoot, bundle);
    const rel = inside && !inside.startsWith('..') ? inside : bundle;
    const code = readFileSync(bundle, 'utf8');
    const sizeKb = (statSync(bundle).size / 1024).toFixed(0);

    // Log context, never a verdict: a plain string literal can fake a specifier
    // and an unused external dependency produces none.
    const seen = packages.map((pkg) => `${pkg}×${countSpecifiers(code, pkg)}`);

    const markerHits = [];
    for (const pkg of packages) {
      for (const marker of MARKERS[pkg] ?? []) {
        if (code.includes(marker)) markerHits.push({ pkg, marker });
      }
    }

    for (const { pkg, marker } of markerHits) {
      errors.push(`${rel} contains ${pkg} bytes: marker ${JSON.stringify(marker)}`);
    }
    if (markerHits.length === 0) {
      notes.push(`${rel} (${sizeKb} KB): no proprietary markers; specifiers ${seen.join(', ')}`);
    }
  }

  return { ok: errors.length === 0, errors, notes };
}

function fail(msg) {
  process.stderr.write(`\x1b[31m[check-no-proprietary] FAIL:\x1b[0m ${msg}\n`);
}
function log(msg) {
  process.stdout.write(`\x1b[36m[check-no-proprietary]\x1b[0m ${msg}\n`);
}

function main(argv) {
  const args = argv.slice(2);
  let declaredExternals = null;
  let metafileInputs = null;
  let allowBytesOnly = false;
  const bundles = [];
  for (const arg of args) {
    if (arg.startsWith('--externals=')) {
      declaredExternals = arg
        .slice('--externals='.length)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--metafile=')) {
      const file = path.resolve(arg.slice('--metafile='.length));
      if (!existsSync(file)) {
        fail(`metafile not found: ${file}`);
        process.exit(1);
      }
      metafileInputs = JSON.parse(readFileSync(file, 'utf8')).inputs ?? {};
    } else if (arg.startsWith('--externals-from=')) {
      const file = path.resolve(arg.slice('--externals-from='.length));
      if (!existsSync(file)) {
        fail(`externals manifest not found: ${file} — build first`);
        process.exit(1);
      }
      declaredExternals = JSON.parse(readFileSync(file, 'utf8')).external ?? [];
    } else if (arg === '--bytes-only') {
      allowBytesOnly = true;
    } else {
      bundles.push(arg);
    }
  }
  if (bundles.length === 0) {
    const dist = path.resolve(process.cwd(), 'dist');
    if (!existsSync(dist)) {
      fail(`no bundles given and ${dist} does not exist — build first, or pass bundle paths`);
      process.exit(1);
    }
    bundles.push(...[...walk(dist)].filter((f) => f.endsWith('.js')));
  }
  if (bundles.length === 0) {
    fail('no .js bundles found to verify');
    process.exit(1);
  }

  const { ok, errors, notes } = checkNoProprietary({
    bundles: bundles.map((b) => path.resolve(b)),
    declaredExternals,
    metafileInputs,
    allowBytesOnly,
  });
  for (const note of notes) log(note);
  if (ok) {
    log(`All ${bundles.length} bundle(s) keep the proprietary packages external ✓`);
    return;
  }
  for (const error of errors) fail(error);
  process.stderr.write(
    `\n  A proprietary package must stay EXTERNAL to every distributed bundle: the\n` +
      `  artifact is FSL-labelled and that future-license grant is irrevocable.\n` +
      `  Add the offending package to the build's \`external\` list — it is arriving\n` +
      `  transitively through a first-party package, not through a direct import.\n`
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
