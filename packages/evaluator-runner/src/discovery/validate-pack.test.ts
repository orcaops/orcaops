import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ResolvedPackSource } from './resolver.js';
import { validatePack } from './validate-pack.js';

/**
 * validatePack is the install-time + doctor-time validation surface
 * for pack sources. Tests cover the success path, every error code,
 * and the trust-boundary warnings.
 */

let scratchDir: string;

beforeEach(async () => {
  scratchDir = realpathSync(await mkdtemp(path.join(tmpdir(), 'orcaops-validate-pack-')));
});

async function buildPack(opts: {
  manifestYaml?: string;
  evaluators?: Array<{ id: string; yaml: string }>;
  /** Touch files at these pack-relative paths so engine.command references resolve. */
  files?: string[];
  /** Touch prompt files at these pack-relative paths. */
  prompts?: string[];
}): Promise<string> {
  const packRoot = path.join(scratchDir, 'pack-' + Math.random().toString(36).slice(2));
  await mkdir(packRoot, { recursive: true });
  await mkdir(path.join(packRoot, 'evaluators'), { recursive: true });
  const manifest =
    opts.manifestYaml ??
    [
      'schema: orcaops.evaluator_package/v1',
      'id: testpack',
      'name: testpack',
      'version: 0.0.1',
      'description: stub pack for validatePack tests',
      'evaluator_dir: ./evaluators',
    ].join('\n');
  await writeFile(path.join(packRoot, 'package.yaml'), manifest, 'utf8');
  for (const evalSpec of opts.evaluators ?? []) {
    await writeFile(
      path.join(packRoot, 'evaluators', `${evalSpec.id}.eval.yaml`),
      evalSpec.yaml,
      'utf8'
    );
  }
  for (const rel of opts.files ?? []) {
    const abs = path.join(packRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, '// stub', 'utf8');
  }
  for (const rel of opts.prompts ?? []) {
    const abs = path.join(packRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, 'You are a test prompt.', 'utf8');
  }
  return packRoot;
}

function resolvedFor(packRoot: string): ResolvedPackSource {
  return { source: { kind: 'path', path: packRoot }, pack_root: packRoot };
}

describe('validatePack', () => {
  it('returns ok when manifest + specs load and command files exist', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'plan-check',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: plan-check',
            'phase: post-plan',
            'severity: info',
            'description: stub',
            'engine:',
            '  kind: command',
            '  command:',
            '    - node',
            '    - ./runtime/plan-check.js',
          ].join('\n'),
        },
      ],
      files: ['runtime/plan-check.js'],
    });

    const result = await validatePack(resolvedFor(packRoot));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('command_evaluators_present');
    expect(result.warnings[0].refs).toEqual(['testpack/plan-check']);
    expect(result.warnings[0].message).toContain('trusted executable code');
    expect(result.warnings[0].message).toContain("invoking user's permissions");
    expect(result.warnings[0].message).toContain('does not sandbox');
    expect(result.specs).toHaveLength(1);
  });

  it('emits command_missing_companion_file when a ./runtime/<x>.js arg is absent', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'no-runtime',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: no-runtime',
            'phase: post-plan',
            'severity: info',
            'description: stub',
            'engine:',
            '  kind: command',
            '  command:',
            '    - node',
            '    - ./runtime/missing.js',
          ].join('\n'),
        },
      ],
    });

    const result = await validatePack(resolvedFor(packRoot));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('command_missing_companion_file');
    expect(result.errors[0].evaluator_id).toBe('testpack/no-runtime');
  });

  it('rejects a directory as the command executable', async () => {
    for (const executable of ['./runtime/bin', 'runtime/bin']) {
      const packRoot = await buildPack({
        evaluators: [
          {
            id: 'directory-executable',
            yaml: [
              'schema: orcaops.evaluator/v1',
              'id: directory-executable',
              'phase: post-plan',
              'severity: info',
              'description: stub',
              'engine:',
              '  kind: command',
              '  command:',
              `    - ${executable}`,
            ].join('\n'),
          },
        ],
      });
      await mkdir(path.join(packRoot, 'runtime', 'bin'), { recursive: true });

      const result = await validatePack(resolvedFor(packRoot));

      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('command_missing_executable');
      expect(result.errors[0].message).toMatch(/not a regular file/);
    }
  });

  it('does not resolve later repo-cwd arguments against the pack root', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'repo-script',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: repo-script',
            'phase: post-plan',
            'severity: info',
            'description: stub',
            'engine:',
            '  kind: command',
            '  command:',
            '    - python3',
            '    - ./checks/repository-owned.py',
            '  cwd: repo',
          ].join('\n'),
        },
      ],
    });

    const result = await validatePack(resolvedFor(packRoot));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('emits prompt_file_missing when engine.prompt_file does not resolve', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'broken-llm',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: broken-llm',
            'phase: pre-pr',
            'severity: warn',
            'description: stub',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/missing.prompt.md',
            '  output_format: markdown',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
        },
      ],
    });

    const result = await validatePack(resolvedFor(packRoot));

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('prompt_file_missing');
    expect(result.warnings[0].code).toBe('llm_evaluators_present');
    expect(result.warnings[0].refs).toEqual(['testpack/broken-llm']);
  });

  it('returns manifest_load error when package.yaml is missing', async () => {
    const result = await validatePack(resolvedFor(path.join(scratchDir, 'does-not-exist')));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('manifest_load');
    expect(result.package_id).toBe('does-not-exist');
  });

  it('reports spec_load errors via the errors[] surface (lenient loader)', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'malformed',
          yaml: 'not: a: valid: spec: this should fail',
        },
      ],
    });

    const result = await validatePack(resolvedFor(packRoot));

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('spec_load');
  });

  it('surfaces both command and llm warnings when both kinds are present', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'cmd-eval',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: cmd-eval',
            'phase: post-plan',
            'severity: info',
            'description: stub',
            'engine:',
            '  kind: command',
            '  command:',
            '    - node',
            '    - ./runtime/cmd-eval.js',
          ].join('\n'),
        },
        {
          id: 'llm-eval',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: llm-eval',
            'phase: pre-pr',
            'severity: warn',
            'description: stub',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/llm-eval.prompt.md',
            '  output_format: markdown',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
        },
      ],
      files: ['runtime/cmd-eval.js'],
      prompts: ['./prompts/llm-eval.prompt.md'],
    });

    const result = await validatePack(resolvedFor(packRoot));

    expect(result.ok).toBe(true);
    const codes = result.warnings.map((w) => w.code).sort();
    expect(codes).toEqual(['command_evaluators_present', 'llm_evaluators_present']);
  });

  it('emits file_reading_llm_evaluator_present for a command-filtered llm evaluator', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'reader',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: reader',
            'phase: pre-pr',
            'severity: warn',
            'description: stub',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/reader.prompt.md',
            '  output_format: markdown',
            '  tool_policy:',
            '    mode: command-filtered',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
        },
      ],
      prompts: ['./prompts/reader.prompt.md'],
    });

    const result = await validatePack(resolvedFor(packRoot));

    expect(result.ok).toBe(true);
    const codes = result.warnings.map((w) => w.code).sort();
    // A file-reading llm evaluator trips BOTH the credit-usage notice and the
    // security file-reading warning.
    expect(codes).toEqual(['file_reading_llm_evaluator_present', 'llm_evaluators_present']);
    const fileReading = result.warnings.find(
      (w) => w.code === 'file_reading_llm_evaluator_present'
    );
    expect(fileReading?.refs).toEqual(['testpack/reader']);
  });

  it('does NOT emit file_reading_llm_evaluator_present for a default (deny-all) llm evaluator', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'plain-llm',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: plain-llm',
            'phase: pre-pr',
            'severity: warn',
            'description: stub',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/plain-llm.prompt.md',
            '  output_format: markdown',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
        },
      ],
      prompts: ['./prompts/plain-llm.prompt.md'],
    });

    const result = await validatePack(resolvedFor(packRoot));

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('llm_evaluators_present');
    expect(codes).not.toContain('file_reading_llm_evaluator_present');
  });

  it('emits file_reading_llm_evaluator_present for a provider-omitted llm evaluator under a codex default', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'plain-llm',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: plain-llm',
            'phase: pre-pr',
            'severity: warn',
            'description: stub',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/plain-llm.prompt.md',
            '  output_format: markdown',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
        },
      ],
      prompts: ['./prompts/plain-llm.prompt.md'],
    });

    // The evaluator declares neither provider nor tool_policy, but it still
    // reaches codex's file-reading tools when the resolved default is codex —
    // validation must classify it exactly as the dispatch gate does,
    // or the capability can never be prompted for, granted, or shipped in
    // the installation manifest.
    const result = await validatePack(resolvedFor(packRoot), { defaultLlmProvider: 'codex' });

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('file_reading_llm_evaluator_present');
    const fileReading = result.warnings.find(
      (w) => w.code === 'file_reading_llm_evaluator_present'
    );
    expect(fileReading?.refs).toEqual(['testpack/plain-llm']);
    expect(fileReading?.message).toContain('Provider tool controls vary');
    expect(fileReading?.message).toContain('not an Orcaops OS sandbox');
    expect(fileReading?.message).toContain("invoking user's permissions");
    expect(fileReading?.message).not.toContain('Claude');
  });

  it('skips command-file checks when skipCommandFileChecks=true', async () => {
    const packRoot = await buildPack({
      evaluators: [
        {
          id: 'no-runtime',
          yaml: [
            'schema: orcaops.evaluator/v1',
            'id: no-runtime',
            'phase: post-plan',
            'severity: info',
            'description: stub',
            'engine:',
            '  kind: command',
            '  command:',
            '    - node',
            '    - ./runtime/missing.js',
          ].join('\n'),
        },
      ],
    });

    const result = await validatePack(resolvedFor(packRoot), {
      skipCommandFileChecks: true,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
