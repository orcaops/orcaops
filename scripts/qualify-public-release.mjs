#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDependencyPolicy } from './check-dependency-policy.mjs';
import { checkPublicContent } from './check-public-content.mjs';
import {
  copyPublicTree,
  findForbiddenInternalReferences,
  findWithheldEntries,
} from './public-tree.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL_CLOUD_ENDPOINT = 'https://api.orcaops.ai';
// Construct the forbidden path token so the public-tree verifier does not report this sentinel.
const INTERNAL_PREFIX = 'internal' + '/';

function run(command, args, cwd, env = {}) {
  process.stdout.write(`\n[public-release] ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: '1', HUSKY: '0', ...env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status ?? result.signal}\n${result.stderr}`
    );
  }
  return result.stdout;
}

function qualify(copyRoot, copied) {
  if (existsSync(path.join(copyRoot, 'internal'))) {
    throw new Error('the physical public-tree copy contains internal/');
  }
  const internalReferences = findForbiddenInternalReferences(copyRoot, copied);
  if (internalReferences.length > 0) {
    throw new Error(`forbidden internal/ references:\n${internalReferences.join('\n')}`);
  }
  const { errors } = checkDependencyPolicy(copyRoot);
  if (errors.length > 0) {
    throw new Error(`dependency policy failed in the public copy:\n${errors.join('\n')}`);
  }

  run('git', ['init', '--quiet', '--initial-branch=main'], copyRoot);
  run('git', ['config', 'user.name', 'Public Release Qualification'], copyRoot);
  run('git', ['config', 'user.email', 'public-release@example.invalid'], copyRoot);
  run('git', ['add', '--all'], copyRoot);
  run('git', ['commit', '--quiet', '-m', 'historyless public tree'], copyRoot);

  run('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], copyRoot);
  run('pnpm', ['audit:prod:ci', '--fail-on-stale-exceptions'], copyRoot);
  run('pnpm', ['build'], copyRoot);
  run('pnpm', ['typecheck'], copyRoot);
  run('pnpm', ['typecheck:tests'], copyRoot);
  run('pnpm', ['release:cli'], copyRoot, { SKIP_BUILD: '1', SKIP_GATE: '0' });

  const productionBundle = path.join(
    copyRoot,
    'build',
    'cli-dist',
    'staging',
    'dist',
    'cli',
    'index.js'
  );
  if (!existsSync(productionBundle)) {
    throw new Error('release:cli did not produce its staged production bundle');
  }
  const productionBundleText = readFileSync(productionBundle, 'utf8');
  if (!productionBundleText.includes(OFFICIAL_CLOUD_ENDPOINT)) {
    throw new Error(`production CLI bundle does not contain ${OFFICIAL_CLOUD_ENDPOINT}`);
  }

  const packagedManifest = JSON.parse(
    readFileSync(path.join(copyRoot, 'build', 'cli-dist', 'staging', 'package.json'), 'utf8')
  );
  const packagedDependencyEntries = Object.entries({
    ...(packagedManifest.dependencies ?? {}),
    ...(packagedManifest.optionalDependencies ?? {}),
  });
  const pathDependencies = packagedDependencyEntries.filter(([, version]) =>
    /^(file|link|workspace):/.test(version)
  );
  if (pathDependencies.length > 0) {
    throw new Error(
      `release manifest contains path-valued dependencies:\n${pathDependencies
        .map(([name, version]) => `${name}: ${version}`)
        .join('\n')}`
    );
  }

  const cliVersion = JSON.parse(
    readFileSync(path.join(copyRoot, 'apps', 'orcaops-cli', 'package.json'), 'utf8')
  ).version;
  const tarball = path.join(copyRoot, 'dist-release', `orcaops-cli-${cliVersion}.tgz`);
  if (!existsSync(tarball)) throw new Error(`release tarball is missing: ${tarball}`);
  const leakedEntries = capture('tar', ['-tzf', tarball], copyRoot)
    .split('\n')
    .map((entry) => entry.replace(/^\.\//, ''))
    .filter(
      (entry) => entry === 'package/internal' || entry.startsWith(`package/${INTERNAL_PREFIX}`)
    );
  if (leakedEntries.length > 0) {
    throw new Error(`release tarball contains internal paths:\n${leakedEntries.join('\n')}`);
  }

  const clean = spawnSync('git', ['status', '--porcelain'], {
    cwd: copyRoot,
    encoding: 'utf8',
  });
  if (clean.error) throw clean.error;
  if (clean.status !== 0 || clean.stdout !== '') {
    throw new Error(
      `qualification mutated the public source tree:\n${clean.stdout}${clean.stderr}`
    );
  }
}

// This verifier copies the tree minus a single directory, so pointing it at the
// source repository would grade something that is not the artifact — and pass.
const withheld = findWithheldEntries(repoRoot);
if (withheld.length > 0) {
  process.stderr.write(
    `[public-release] refusing to qualify this tree: it still contains ` +
      `${withheld.join(', ')}.\nQualify the exported tree instead — the export applies the ` +
      `full withheld set, which this verifier does not implement.\n`
  );
  process.exit(1);
}

const copyRoot = mkdtempSync(path.join(tmpdir(), 'orcaops-public-release-'));
try {
  // Scanned at the source, not in the copy: the exclusion list lives in the
  // withheld tree, so the source is the only place the shipped set is derivable.
  process.stdout.write('[public-release] scanning the shipped set for private content\n');
  const content = checkPublicContent(repoRoot);
  if (content.findings.length > 0) {
    throw new Error(`private content in the shipped set:\n${content.findings.join('\n')}`);
  }
  process.stdout.write(`[public-release] ${content.scanned} text files clean\n`);

  process.stdout.write(`[public-release] materializing ${copyRoot} without internal/\n`);
  const copied = copyPublicTree(repoRoot, copyRoot);
  qualify(copyRoot, copied);
  process.stdout.write('\n[public-release] qualification passed\n');
} catch (error) {
  process.stderr.write(`\n[public-release] qualification failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(copyRoot, { recursive: true, force: true });
}
