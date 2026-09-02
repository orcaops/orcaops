import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computePackSourceFingerprint } from './pack-fingerprint.js';
import type { ResolvedPackSource } from './resolver.js';
import { validatePack } from './validate-pack.js';

/**
 * Declared-pack-file fingerprint tests. Covers stability, included-input
 * mutation paths, executable-closure exclusions, and the bare /
 * absolute-system-interpreter / inside-pack-absolute / escape command-arg
 * classifications.
 */

let scratchDir: string;

beforeEach(async () => {
  scratchDir = realpathSync(await mkdtemp(path.join(tmpdir(), 'orcaops-pack-fp-')));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

async function buildBasePack(): Promise<string> {
  const packRoot = path.join(scratchDir, 'pack');
  await mkdir(path.join(packRoot, 'evaluators'), { recursive: true });
  await mkdir(path.join(packRoot, 'runtime'), { recursive: true });
  await mkdir(path.join(packRoot, 'prompts'), { recursive: true });
  await mkdir(path.join(packRoot, 'descriptions'), { recursive: true });
  await mkdir(path.join(packRoot, 'extras'), { recursive: true });
  await writeFile(
    path.join(packRoot, 'package.yaml'),
    [
      'schema: orcaops.evaluator_package/v1',
      'id: testpack',
      'name: testpack',
      'version: 0.0.1',
      'description: stub pack',
      'evaluator_dir: ./evaluators',
    ].join('\n'),
    'utf8'
  );
  await writeFile(path.join(packRoot, 'runtime', 'cmd.js'), '// initial runtime\n', 'utf8');
  await writeFile(path.join(packRoot, 'prompts', 'llm.md'), 'initial prompt\n', 'utf8');
  await writeFile(path.join(packRoot, 'descriptions', 'desc.md'), 'initial desc\n', 'utf8');
  await writeFile(path.join(packRoot, 'extras', 'fp1.txt'), 'initial fp\n', 'utf8');
  await writeFile(
    path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml'),
    [
      'schema: orcaops.evaluator/v1',
      'id: cmd-eval',
      'phase: post-plan',
      'severity: info',
      'description_file: ./descriptions/desc.md',
      'engine:',
      '  kind: command',
      '  command:',
      '    - node',
      '    - ./runtime/cmd.js',
      'fingerprint:',
      '  include:',
      "    - 'extras/**'",
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    path.join(packRoot, 'evaluators', 'llm-eval.eval.yaml'),
    [
      'schema: orcaops.evaluator/v1',
      'id: llm-eval',
      'phase: pre-pr',
      'severity: warn',
      'description: inline desc',
      'engine:',
      '  kind: llm',
      '  additional_context_sections: []',
      '  prompt_file: ./prompts/llm.md',
      '  output_format: markdown',
      'filters:',
      '  when_llm: required',
    ].join('\n'),
    'utf8'
  );
  return packRoot;
}

function resolvedFor(packRoot: string): ResolvedPackSource {
  return { source: { kind: 'path', path: packRoot }, pack_root: packRoot };
}

describe('computePackSourceFingerprint', () => {
  it('returns a 64-char hex sha256 for a valid pack', async () => {
    const packRoot = await buildBasePack();
    const result = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across consecutive calls on identical content', async () => {
    const packRoot = await buildBasePack();
    const a = await computePackSourceFingerprint(resolvedFor(packRoot));
    const b = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('manifest mutation changes the fingerprint', async () => {
    const packRoot = await buildBasePack();
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    await writeFile(
      path.join(packRoot, 'package.yaml'),
      [
        'schema: orcaops.evaluator_package/v1',
        'id: testpack',
        'name: testpack',
        'version: 0.0.2',
        'description: mutated',
        'evaluator_dir: ./evaluators',
      ].join('\n'),
      'utf8'
    );
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('spec mutation changes the fingerprint', async () => {
    const packRoot = await buildBasePack();
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: checkpoint-close',
        'severity: warn',
        'description_file: ./descriptions/desc.md',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - ./runtime/cmd.js',
      ].join('\n'),
      'utf8'
    );
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('engine.command runtime-file mutation changes the fingerprint', async () => {
    const packRoot = await buildBasePack();
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    await writeFile(path.join(packRoot, 'runtime', 'cmd.js'), '// mutated runtime\n', 'utf8');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('does not fingerprint an imported helper unless the pack declares it', async () => {
    const packRoot = await buildBasePack();
    const runtimePath = path.join(packRoot, 'runtime', 'cmd.js');
    const helperPath = path.join(packRoot, 'runtime', 'helper.js');
    await writeFile(runtimePath, "import './helper.js';\n", 'utf8');
    await writeFile(helperPath, 'export const value = 1;\n', 'utf8');

    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    await writeFile(helperPath, 'export const value = 2;\n', 'utf8');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));

    expect(before.inputs).not.toContain(helperPath);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('hashes an existing bare-relative command file without a ./ prefix', async () => {
    const packRoot = await buildBasePack();
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - runtime/cmd.js',
      ].join('\n'),
      'utf8'
    );

    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(before.inputs).toContain(path.join(packRoot, 'runtime', 'cmd.js'));
    await writeFile(path.join(packRoot, 'runtime', 'cmd.js'), '// changed bare runtime\n');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('hashes an unprefixed package-cwd path used as command[0]', async () => {
    const packRoot = await buildBasePack();
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    const runtimePath = path.join(packRoot, 'runtime', 'cmd.js');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - runtime/cmd.js',
      ].join('\n'),
      'utf8'
    );

    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(before.inputs).toContain(runtimePath);
    await writeFile(runtimePath, '// changed command executable\n');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('does not treat directory arguments as source files regardless of spelling', async () => {
    const packRoot = await buildBasePack();
    const fixturesDir = path.join(packRoot, 'runtime', 'fixtures');
    await mkdir(fixturesDir);
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    for (const arg of ['runtime/fixtures', './runtime/fixtures', fixturesDir]) {
      await writeFile(
        specPath,
        [
          'schema: orcaops.evaluator/v1',
          'id: cmd-eval',
          'phase: post-plan',
          'severity: info',
          'description: inline',
          'engine:',
          '  kind: command',
          '  command:',
          '    - node',
          `    - ${JSON.stringify(arg)}`,
        ].join('\n'),
        'utf8'
      );

      const validation = await validatePack(resolvedFor(packRoot));
      const result = await computePackSourceFingerprint(resolvedFor(packRoot));

      expect(validation.ok).toBe(true);
      expect(result.inputs).not.toContain(fixturesDir);
    }
  });

  it('excludes later repo-cwd relative arguments from the pack fingerprint', async () => {
    const packRoot = await buildBasePack();
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - ./checks/repository-owned.js',
        '  cwd: repo',
      ].join('\n'),
      'utf8'
    );

    const validation = await validatePack(resolvedFor(packRoot));
    const result = await computePackSourceFingerprint(resolvedFor(packRoot));

    expect(validation.ok).toBe(true);
    expect(result.inputs.some((input) => input.includes('repository-owned.js'))).toBe(false);
  });

  it('accepts an in-pack command file whose segment starts with two dots', async () => {
    const packRoot = await buildBasePack();
    const unusualDir = path.join(packRoot, '..runtime');
    await mkdir(unusualDir);
    const unusualFile = path.join(unusualDir, 'cmd.js');
    await writeFile(unusualFile, '// unusual but contained\n');
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - ./..runtime/cmd.js',
      ].join('\n'),
      'utf8'
    );

    const validation = await validatePack(resolvedFor(packRoot));
    expect(validation.ok).toBe(true);
    const fingerprint = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(fingerprint.inputs).toContain(unusualFile);
  });

  it('prompt_file mutation changes the fingerprint', async () => {
    const packRoot = await buildBasePack();
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    await writeFile(path.join(packRoot, 'prompts', 'llm.md'), 'mutated prompt\n', 'utf8');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('hashes raw bytes rather than UTF-8 replacement characters', async () => {
    const packRoot = await buildBasePack();
    const prompt = path.join(packRoot, 'prompts', 'llm.md');
    await writeFile(prompt, Uint8Array.from([0x80]));
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));

    await writeFile(prompt, Uint8Array.from([0x81]));
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));

    expect(Buffer.from([0x80]).toString('utf8')).toBe(Buffer.from([0x81]).toString('utf8'));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('description_file mutation changes the fingerprint', async () => {
    const packRoot = await buildBasePack();
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    await writeFile(path.join(packRoot, 'descriptions', 'desc.md'), 'mutated desc\n', 'utf8');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('fingerprint.include-matched file mutation changes the fingerprint', async () => {
    const packRoot = await buildBasePack();
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    await writeFile(path.join(packRoot, 'extras', 'fp1.txt'), 'mutated fp\n', 'utf8');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('retargeting a fingerprint.include symlink changes a fresh consent fingerprint', async () => {
    const packRoot = await buildBasePack();
    const targetsDir = path.join(packRoot, 'targets');
    await mkdir(targetsDir);
    const firstTarget = path.join(targetsDir, 'first.txt');
    const secondTarget = path.join(targetsDir, 'second.txt');
    await writeFile(firstTarget, 'same bytes\n');
    await writeFile(secondTarget, 'same bytes\n');
    const link = path.join(packRoot, 'extras', 'current.txt');
    await symlink(firstTarget, link);
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - ./runtime/cmd.js',
        'fingerprint:',
        '  include:',
        "    - 'extras/current.txt'",
      ].join('\n'),
      'utf8'
    );

    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    await unlink(link);
    await symlink(secondTarget, link);
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));

    expect(before.inputs).toContain(firstTarget);
    expect(after.inputs).toContain(secondTarget);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('bare-token engine.command[0] (`node`) does not attempt a read', async () => {
    // The base pack uses ['node', './runtime/cmd.js']; if `node` were
    // treated as a file path the test would fail when reading it. The
    // happy-path stability test above implicitly proves the bare-token
    // branch; this test is the explicit confirmation that fingerprint
    // computation succeeds.
    const packRoot = await buildBasePack();
    const result = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(result.inputs.every((p) => !p.endsWith('/node'))).toBe(true);
  });

  it('absolute system-interpreter engine.command[0] (`/usr/bin/env`) is skipped', async () => {
    const packRoot = await buildBasePack();
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - /usr/bin/env',
        '    - node',
        '    - ./runtime/cmd.js',
      ].join('\n'),
      'utf8'
    );
    const result = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(result.inputs.every((p) => p !== '/usr/bin/env')).toBe(true);
  });

  it('path-style engine.command[0] (`./runtime/foo.mjs`) is hashed', async () => {
    const packRoot = await buildBasePack();
    await writeFile(path.join(packRoot, 'runtime', 'standalone.mjs'), '// standalone\n', 'utf8');
    const specPath = path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml');
    await writeFile(
      specPath,
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - ./runtime/standalone.mjs',
      ].join('\n'),
      'utf8'
    );
    const before = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(before.inputs.some((p) => p.endsWith('runtime/standalone.mjs'))).toBe(true);

    await writeFile(path.join(packRoot, 'runtime', 'standalone.mjs'), '// mutated\n', 'utf8');
    const after = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('identical pack content at different roots produces identical fingerprints', async () => {
    const packRootA = await buildBasePack();
    const packRootB = path.join(scratchDir, 'pack-copy');
    await cp(packRootA, packRootB, { recursive: true });
    const a = await computePackSourceFingerprint(resolvedFor(packRootA));
    const b = await computePackSourceFingerprint(resolvedFor(packRootB));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('validatePack rejects an escaping description_file before any read', async () => {
    // The escape-path guard lives in spec.ts:resolveDescription. If
    // a malicious pack sets description_file to ../../sensitive,
    // validatePack must surface path_escapes_pack and not have
    // touched the target.
    const packRoot = await buildBasePack();
    // Replace one spec's description_file with an escape.
    await writeFile(
      path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description_file: ../../sensitive.md',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - ./runtime/cmd.js',
      ].join('\n'),
      'utf8'
    );
    const result = await validatePack(resolvedFor(packRoot));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'path_escapes_pack')).toBe(true);
  });

  it('validatePack rejects an escaping engine.command relative path', async () => {
    const packRoot = await buildBasePack();
    await writeFile(
      path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - ../../escape.mjs',
      ].join('\n'),
      'utf8'
    );
    const result = await validatePack(resolvedFor(packRoot));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'path_escapes_pack')).toBe(true);
  });

  it('validatePack rejects an absolute engine.command path outside pack_root', async () => {
    const packRoot = await buildBasePack();
    await writeFile(
      path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        '    - /etc/passwd',
      ].join('\n'),
      'utf8'
    );
    const result = await validatePack(resolvedFor(packRoot));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'path_escapes_pack')).toBe(true);
  });

  it('validatePack accepts an absolute engine.command path inside pack_root', async () => {
    const packRoot = await buildBasePack();
    const absRuntime = path.join(packRoot, 'runtime', 'cmd.js');
    await writeFile(
      path.join(packRoot, 'evaluators', 'cmd-eval.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: cmd-eval',
        'phase: post-plan',
        'severity: info',
        'description: inline',
        'engine:',
        '  kind: command',
        '  command:',
        '    - node',
        `    - ${absRuntime}`,
      ].join('\n'),
      'utf8'
    );
    const result = await validatePack(resolvedFor(packRoot));
    expect(result.ok).toBe(true);
    const fp = await computePackSourceFingerprint(resolvedFor(packRoot));
    expect(fp.inputs.some((p) => p === absRuntime)).toBe(true);
  });
});
