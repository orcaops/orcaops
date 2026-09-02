// Third-party attribution for a distribution, shared by every release build.
//
// The obligation: MIT, ISC, BSD and Apache-2.0 each require the copyright line
// AND the permission text in every copy. Naming a licence in a heading does not
// satisfy any of them.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// Matched on the leading id, so `BSD-3-Clause` and `Apache-2.0 WITH
// LLVM-exception` are covered without enumerating every expression.
export const NOTICE_REQUIRING = /^(MIT|ISC|BSD-|Apache-2\.0|BSD|Zlib|libpng)/i;

export const COVERED_BY_ROOT_LICENSE = /^FSL-1\.1-/i;

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function declaredLicense(meta) {
  const raw = meta.license ?? meta.licenses;
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : raw.trim();
  return raw === undefined || raw === null ? undefined : raw;
}

// Every licence file, not just the first: reproducing only `LICENSE-MIT` from a
// dual-licensed package attributes it wrongly. Directories are skipped so a
// REUSE-style `LICENSES/` tree cannot crash the build with EISDIR.
export function licenseFiles(pkgDir) {
  return readdirSync(pkgDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^(LICEN[CS]E|COPYING|NOTICE)/i.test(e.name))
    .map((e) => e.name)
    .sort();
}

// Returns the REAL path. pnpm symlinks one installed copy into each dependent,
// and a package's own dependencies are siblings of the real directory; walking
// up from the symlink would find the DEPENDENT's dependencies instead.
export function resolvePackageDir(name, from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function enumeratePackages(nodeModules) {
  if (!existsSync(nodeModules)) return [];
  const out = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      const scope = path.join(nodeModules, entry.name);
      for (const sub of readdirSync(scope, { withFileTypes: true })) {
        if (sub.isDirectory() && existsSync(path.join(scope, sub.name, 'package.json'))) {
          out.push(path.join(scope, sub.name));
        }
      }
    } else if (existsSync(path.join(nodeModules, entry.name, 'package.json'))) {
      out.push(path.join(nodeModules, entry.name));
    }
  }
  return out.sort();
}

// An unresolvable dependency is fatal rather than skipped: a silently omitted
// notice is the failure this module exists to prevent.
export function collectPackages({ seeds, from, externals = [], rootDir = from }) {
  const found = new Map();
  const visited = new Set();
  const missing = [];
  const queue = seeds.map((name) => ({ name, from }));

  while (queue.length > 0) {
    const { name, from: base } = queue.shift();
    if (externals.includes(name)) continue;
    const dir = resolvePackageDir(name, base);
    if (dir === null) {
      missing.push(`${name} (required by ${path.relative(rootDir, base) || '.'})`);
      continue;
    }
    if (visited.has(dir)) continue;
    visited.add(dir);
    const meta = readJson(path.join(dir, 'package.json'));
    found.set(`${meta.name}@${meta.version}`, dir);
    for (const dep of Object.keys(meta.dependencies ?? {})) queue.push({ name: dep, from: dir });
  }

  if (missing.length > 0) {
    throw new Error(
      `cannot locate these bundled dependencies to attribute them:\n    ${missing.join('\n    ')}`
    );
  }
  return found;
}

// Vendored in the repository, not beside the package: installs live under the
// untracked `node_modules/.pnpm`, so the next install would erase them.
export const SUPPLEMENTAL_DIR = 'third-party-notices';

// `@tokenizer/token` at 0.3.0 is `@tokenizer+token@0.3.0`. Keyed by version as
// well as name: a notice sourced for one version is not evidence about another.
export function supplementalDirName(name, version) {
  return `${name.split('/').join('+')}@${version}`;
}

export function readSupplementalNotice(supplementalDir, name, version) {
  const dir = path.join(supplementalDir, supplementalDirName(name, version));
  const licenseFile = path.join(dir, 'LICENSE');
  if (!existsSync(licenseFile) || !statSync(licenseFile).isFile()) return null;

  const text = readFileSync(licenseFile, 'utf8');
  if (text.trim() === '') {
    throw new Error(
      `the supplemental notice for ${name}@${version} (${dir}) is empty, so it attributes ` +
        `nothing. Replace it with the upstream notice text or remove the directory.`
    );
  }

  const sourceFile = path.join(dir, 'SOURCE.txt');
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) {
    throw new Error(
      `the supplemental notice for ${name}@${version} (${dir}) has no SOURCE.txt, so where its ` +
        `text came from cannot be checked. An unsourced licence file is worse than a missing ` +
        `one — it asserts a provenance nobody can verify. Record the fetch URL and commit in ` +
        `SOURCE.txt, or remove the directory.`
    );
  }
  const source = readFileSync(sourceFile, 'utf8');
  if (source.trim() === '') {
    throw new Error(
      `the SOURCE.txt beside the supplemental notice for ${name}@${version} (${dir}) is empty, ` +
        `so where its text came from cannot be checked. Record the fetch URL and commit in it, ` +
        `or remove the directory.`
    );
  }

  return { text: text.trim(), source: source.trim(), dir };
}

export function renderNotice(
  pkgDir,
  { rootDir = pkgDir, supplementalDir = path.join(rootDir, SUPPLEMENTAL_DIR) } = {}
) {
  const meta = readJson(path.join(pkgDir, 'package.json'));
  const declared = declaredLicense(meta);
  const files = licenseFiles(pkgDir);
  const where = path.relative(rootDir, pkgDir) || pkgDir;

  // Only when the package ships nothing of its own: preferring a vendored copy
  // over a package's own licence file would let the two drift silently.
  const supplemental =
    files.length === 0 ? readSupplementalNotice(supplementalDir, meta.name, meta.version) : null;

  if (declared === undefined && files.length === 0 && supplemental === null) {
    throw new Error(
      `cannot determine the license of ${meta.name}@${meta.version} (${where}): it declares no ` +
        `"license" field and carries no LICENSE file, so this distribution would ship its code ` +
        `with no notice.`
    );
  }
  if (
    files.length === 0 &&
    supplemental === null &&
    typeof declared === 'string' &&
    NOTICE_REQUIRING.test(declared) &&
    !COVERED_BY_ROOT_LICENSE.test(declared)
  ) {
    throw new Error(
      `${meta.name}@${meta.version} (${where}) declares "${declared}" but ships no license file, ` +
        `so its copyright and permission notice cannot be reproduced. ${declared} requires that ` +
        `notice in all copies. Add a sourced notice under ` +
        `${SUPPLEMENTAL_DIR}/${supplementalDirName(meta.name, meta.version)}/ (LICENSE plus a ` +
        `SOURCE.txt recording where it was fetched from) or drop the dependency — a heading ` +
        `naming the licence does not satisfy it.`
    );
  }

  const label = declared === undefined ? 'SEE LICENSE FILE' : declared;
  const block = [
    `### ${meta.name}@${meta.version} — ${typeof label === 'string' ? label : JSON.stringify(label)}`,
  ];
  for (const f of files) block.push('', readFileSync(path.join(pkgDir, f), 'utf8').trim());
  if (supplemental !== null) {
    // The provenance line goes before the notice, never inside it: the
    // reproduced licence has to stay byte-verbatim against upstream.
    block.push(
      '',
      `This package ships no license file. The notice below was fetched from the ` +
        `repository the package declares; see ` +
        `${SUPPLEMENTAL_DIR}/${supplementalDirName(meta.name, meta.version)}/SOURCE.txt.`,
      '',
      supplemental.text
    );
  }
  block.push('');
  return block;
}
