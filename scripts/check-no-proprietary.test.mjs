import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MARKERS, PROPRIETARY_PACKAGES, checkNoProprietary } from './check-no-proprietary.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-no-proprietary.mjs');
const resolveDir = path.join(repoRoot, 'apps', 'orcaops-cli');

let dir;

async function bundle(name, contents, external = []) {
  const outfile = path.join(dir, name);
  const declared = ['better-sqlite3', '@napi-rs/keyring', ...external];
  const result = await build({
    stdin: { contents, loader: 'js', resolveDir, sourcefile: `${name}.in.js` },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify: true,
    treeShaking: true,
    mainFields: ['module', 'main'],
    conditions: ['node', 'import'],
    external: declared,
    metafile: true,
    logLevel: 'silent',
  });
  return { file: outfile, declared, inputs: result.metafile.inputs };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orcaops-no-proprietary-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a bundle that inlined @orcaops/sdk', () => {
  // The wire layer alone leaves the auth and credential code — where every sdk
  // marker lives — unreachable, and therefore tree-shaken away.
  const WIRE_LAYER_ONLY = [
    "import { CloudWireError, TrpcRequestError, trimTrailingSlash } from '@orcaops/sdk';",
    'console.log(CloudWireError, TrpcRequestError, trimTrailingSlash);',
  ].join('\n');

  let inlined;

  beforeAll(async () => {
    inlined = await bundle('sdk-inlined.js', WIRE_LAYER_ONLY);
  }, 60_000);

  it('really does carry hundreds of KB of inlined sdk bytes', () => {
    const code = readFileSync(inlined.file, 'utf8');
    expect(code.length).toBeGreaterThan(100_000);
    expect(code).toContain('CloudWireError');
  });

  it('trips none of the sdk string markers, which is why they cannot be the gate', () => {
    const code = readFileSync(inlined.file, 'utf8');
    const tripped = MARKERS['@orcaops/sdk'].filter((marker) => code.includes(marker));
    expect(tripped).toEqual([]);
  });

  it('fails on the module graph, which names it as an input', () => {
    const { ok, errors } = checkNoProprietary({
      bundles: [inlined.file],
      packages: ['@orcaops/sdk'],
      repoRoot,
      metafileInputs: inlined.inputs,
    });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('module graph');
    expect(errors.join('\n')).toContain('@orcaops/sdk');
  });

  it('fails on the build declaration, which omits it', () => {
    const { ok, errors } = checkNoProprietary({
      bundles: [inlined.file],
      packages: ['@orcaops/sdk'],
      repoRoot,
      declaredExternals: inlined.declared,
    });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('did not declare');
  });

  it('still fails when the output carries a decoy import specifier', async () => {
    const decoyed = await bundle(
      'sdk-inlined-decoy.js',
      `${WIRE_LAYER_ONLY}\nconsole.log('reinstall with: require("@orcaops/sdk")');`
    );
    expect(readFileSync(decoyed.file, 'utf8')).toContain('"@orcaops/sdk"');
    const { ok, errors } = checkNoProprietary({
      bundles: [decoyed.file],
      packages: ['@orcaops/sdk'],
      repoRoot,
      metafileInputs: decoyed.inputs,
    });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('module graph');
  }, 60_000);

  it('refuses to render a verdict at all when given no authoritative evidence', () => {
    const { ok, errors } = checkNoProprietary({
      bundles: [inlined.file],
      packages: ['@orcaops/sdk'],
      repoRoot,
    });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('no authoritative evidence');
  });

  it('fails through the command line too, with a non-zero exit', () => {
    const run = spawnSync(
      process.execPath,
      [scriptPath, `--externals=${inlined.declared.join(',')}`, inlined.file],
      { encoding: 'utf8' }
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('@orcaops/sdk');
  });
});

describe('a bundle that kept the packages external', () => {
  let external;

  beforeAll(async () => {
    external = await bundle(
      'all-external.js',
      [
        "import { trimTrailingSlash } from '@orcaops/sdk';",
        "import { ORCAOPS_CAPABILITIES } from '@orcaops/protocol';",
        "import { summarizeManifest } from '@orcaops/diff-fingerprint';",
        'console.log(trimTrailingSlash, ORCAOPS_CAPABILITIES, summarizeManifest);',
      ].join('\n'),
      ['@orcaops/sdk', '@orcaops/protocol', '@orcaops/diff-fingerprint']
    );
  }, 60_000);

  it('passes', () => {
    const { ok, errors } = checkNoProprietary({
      bundles: [external.file],
      repoRoot,
      declaredExternals: external.declared,
      metafileInputs: external.inputs,
    });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('passes through the command line too', () => {
    const run = spawnSync(
      process.execPath,
      [scriptPath, `--externals=${external.declared.join(',')}`, external.file],
      { encoding: 'utf8' }
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});

describe('the secondary marker scan', () => {
  it('still reports a marker in a bundle that imports the package as well', async () => {
    // Both authoritative checks are satisfied here; only the marker scan can
    // see the smuggled bytes.
    const smuggled = path.join(dir, 'smuggled.js');
    const external = await bundle(
      'external-for-smuggling.js',
      "import { trimTrailingSlash } from '@orcaops/sdk';\nconsole.log(trimTrailingSlash);",
      ['@orcaops/sdk']
    );
    const marker = MARKERS['@orcaops/sdk'][0];
    writeFileSync(
      smuggled,
      `${readFileSync(external.file, 'utf8')}\nconst leak = ${JSON.stringify(marker)};\n`
    );

    const { ok, errors } = checkNoProprietary({
      bundles: [smuggled],
      packages: ['@orcaops/sdk'],
      repoRoot,
      declaredExternals: external.declared,
      metafileInputs: external.inputs,
    });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('contains @orcaops/sdk bytes');
  }, 60_000);

  it('refuses to run vacuously when the proprietary packages are not installed', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'orcaops-no-install-'));
    try {
      const { ok, errors } = checkNoProprietary({
        bundles: [path.join(dir, 'sdk-inlined.js')],
        repoRoot: empty,
        declaredExternals: [],
      });
      expect(ok).toBe(false);
      expect(errors.join('\n')).toContain('not resolvable');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('validates every marker against the installed package before using it', () => {
    const { notes } = checkNoProprietary({
      bundles: [path.join(dir, 'all-external.js')],
      repoRoot,
      declaredExternals: PROPRIETARY_PACKAGES,
    });
    const total = Object.values(MARKERS).reduce((n, list) => n + list.length, 0);
    expect(notes).toContain(
      `${total} markers validated against the installed proprietary packages ✓`
    );
  });
});

describe('argument handling', () => {
  it('rejects an empty bundle list rather than passing', () => {
    const { ok, errors } = checkNoProprietary({ bundles: [], repoRoot });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('no bundles');
  });

  it('reports a bundle path that does not exist', () => {
    const { ok, errors } = checkNoProprietary({
      bundles: [path.join(dir, 'absent.js')],
      repoRoot,
      declaredExternals: PROPRIETARY_PACKAGES,
    });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('bundle not found');
  });
});
