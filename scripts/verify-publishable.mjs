#!/usr/bin/env node
// Refuse to publish a staging directory that is not publishable.
//
// It reads the staging directory, not a packed tarball: staging is what `npm
// publish` packs from, so a tarball from a separate `npm pack` is a different
// artifact.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { PROPRIETARY_PACKAGES, checkNoProprietary } from './check-no-proprietary.mjs';
import { baseVersionOf, isPrerelease } from './release-channel.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const staging = path.resolve(process.argv[2] ?? path.join(ROOT, 'build', 'cli-dist', 'staging'));
const FSL_ID = 'FSL-1.1-ALv2';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const problems = [];
const checked = [];

function check(label, fn) {
  try {
    const detail = fn();
    checked.push(detail ? `${label} — ${detail}` : label);
  } catch (error) {
    problems.push(`${label}: ${error.message}`);
  }
}

if (!existsSync(staging)) {
  process.stderr.write(`verify-publishable: no staging directory at ${staging}\n`);
  process.exit(1);
}

check('manifest declares the FSL licence', () => {
  const meta = JSON.parse(readFileSync(path.join(staging, 'package.json'), 'utf8'));
  if (meta.license !== FSL_ID) {
    throw new Error(`expected "${FSL_ID}", found ${JSON.stringify(meta.license ?? null)}`);
  }
  if (meta.private === true) throw new Error('manifest is marked private');
  return `${meta.name}@${meta.version}`;
});

check('the licence it declares is actually present', () => {
  const license = path.join(staging, 'LICENSE');
  if (!existsSync(license)) throw new Error('no LICENSE beside the manifest that names one');
  const body = readFileSync(license, 'utf8');
  if (!body.includes('Functional Source License')) {
    throw new Error('LICENSE is present but is not the FSL text');
  }
  return `${(statSync(license).size / 1024).toFixed(1)} KB`;
});

check('no do-not-publish marker', () => {
  const marker = readdirSync(staging).find((f) => /^DO-NOT-PUBLISH/i.test(f));
  if (marker) throw new Error(`staging carries ${marker} — this is a local test artifact`);
});

check('the npm page will render a README and a changelog', () => {
  const missing = ['README.md', 'CHANGELOG.md'].filter(
    (doc) => !existsSync(path.join(staging, doc))
  );
  if (missing.length > 0) throw new Error(`staging is missing ${missing.join(', ')}`);
  return missing.length === 0 ? 'README.md, CHANGELOG.md' : '';
});

check('the changelog documents the version being published', () => {
  const meta = JSON.parse(readFileSync(path.join(staging, 'package.json'), 'utf8'));
  const changelog = readFileSync(path.join(staging, 'CHANGELOG.md'), 'utf8');
  // A published page is frozen, so an un-noted release is a permanent defect:
  // the top-most version heading must be the version going out. A candidate
  // is documented by the section it is heading toward — either the base
  // version or a still-open Unreleased — because its notes are being written,
  // and forcing a heading per candidate would rewrite history at promotion.
  const leading = /^## \[?([^\]\s]+)\]?/m.exec(changelog);
  if (leading === null) throw new Error('no section heading found');
  const found = leading[1];
  if (isPrerelease(meta.version)) {
    const accepted = new Set([meta.version, baseVersionOf(meta.version), 'Unreleased']);
    if (!accepted.has(found)) {
      throw new Error(
        `changelog leads with ${found}; a candidate for ${meta.version} needs ` +
          `${baseVersionOf(meta.version)} or Unreleased`
      );
    }
    return `candidate documented by ${found}`;
  }
  if (found !== meta.version) {
    throw new Error(`changelog leads with ${found}, publishing ${meta.version}`);
  }
  return `leads with ${found}`;
});

check('third-party notices are present', () => {
  const notices = path.join(staging, 'THIRD-PARTY-NOTICES');
  if (!existsSync(notices)) throw new Error('no THIRD-PARTY-NOTICES');
  const entries = readFileSync(notices, 'utf8').match(/^### /gm)?.length ?? 0;
  if (entries === 0) throw new Error('THIRD-PARTY-NOTICES has no entries');
  return `${entries} entries`;
});

check('no proprietary code in the bundle it will publish', () => {
  const bundle = path.join(staging, 'dist', 'cli', 'index.js');
  if (!existsSync(bundle)) throw new Error('no dist/cli/index.js to check');
  // Bytes-only: the staging directory carries no module graph and no build
  // declaration, so markers are all there is to scan.
  const { ok, errors } = checkNoProprietary({
    bundles: [bundle],
    packages: PROPRIETARY_PACKAGES,
    repoRoot: ROOT,
    allowBytesOnly: true,
  });
  if (!ok) throw new Error(errors.join('; '));
});

check('no stray licence claims in the bundled packages', () => {
  // A bundled package declaring FSL is first-party. Third-party terms are
  // fine ONLY when THIRD-PARTY-NOTICES carries that exact name@version —
  // anything else is a licence claim this distribution never accounted for.
  const nm = path.join(staging, 'node_modules');
  if (!existsSync(nm)) return 'no bundled packages';
  const notices = readFileSync(path.join(staging, 'THIRD-PARTY-NOTICES'), 'utf8');
  let count = 0;
  let noticed = 0;
  const stray = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        visit(child);
        continue;
      }
      const pj = path.join(child, 'package.json');
      if (!existsSync(pj)) continue;
      count += 1;
      const meta = JSON.parse(readFileSync(pj, 'utf8'));
      if (meta.license === FSL_ID) continue;
      if (new RegExp(`^### ${escapeRegExp(`${meta.name}@${meta.version}`)} — `, 'm').test(notices)) {
        noticed += 1;
        continue;
      }
      stray.push(
        `${meta.name ?? path.relative(nm, child)}@${meta.version ?? '?'} declares ${JSON.stringify(meta.license ?? null)} and is not in THIRD-PARTY-NOTICES`
      );
    }
  };
  visit(nm);
  if (stray.length > 0) throw new Error(stray.join('; '));
  return `${count} bundled package(s): ${count - noticed} first-party, ${noticed} covered by notices`;
});

for (const line of checked) process.stdout.write(`  ✓ ${line}\n`);
if (problems.length > 0) {
  process.stderr.write('\nverify-publishable: refusing to publish this staging directory:\n');
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.stderr.write(
    '\n  Do not publish this directory. Publication is irreversible, and an\n' +
      '  FSL-labelled artifact grants an irrevocable future licence over whatever\n' +
      '  it ships with. Fix the build, do not relax this check.\n'
  );
  process.exit(1);
}
process.stdout.write(`verify-publishable: ${staging} is publishable\n`);
