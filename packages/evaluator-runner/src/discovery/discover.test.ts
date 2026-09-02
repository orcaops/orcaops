import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverEvaluators } from './discover.js';
import { EvaluatorDiscoveryError } from './errors.js';

/**
 * Tests build a minimal pack tree under a temp dir and assert
 * discovery behavior end-to-end. Helpers below build the standard
 * shapes; individual tests override fields to exercise specific
 * branches.
 */

const ORCAOPS_CONFIG_DIR = '.orcaops';

interface PackSpec {
  id: string;
  /** Relative path under `.orcaops/evaluators/<dir>/`. */
  dir: string;
  evaluators?: Array<{
    id: string;
    yaml: string;
    /** When set, also write a description_file under <pack>/docs/. */
    descriptionFile?: { name: string; content: string };
  }>;
  /** Override the package.yaml manifest verbatim (raw YAML text). */
  manifestYaml?: string;
}

interface RepoFixture {
  repoRoot: string;
}

async function buildRepo(spec: {
  configYaml?: string | null;
  packs: PackSpec[];
}): Promise<RepoFixture> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-discover-'));
  await mkdir(path.join(repoRoot, ORCAOPS_CONFIG_DIR), { recursive: true });

  if (spec.configYaml !== null && spec.configYaml !== undefined) {
    await writeFile(
      path.join(repoRoot, ORCAOPS_CONFIG_DIR, 'evaluators.yaml'),
      spec.configYaml,
      'utf8'
    );
  }

  for (const pack of spec.packs) {
    const packRoot = path.join(repoRoot, ORCAOPS_CONFIG_DIR, 'evaluators', pack.dir);
    await mkdir(packRoot, { recursive: true });
    const manifestYaml =
      pack.manifestYaml ??
      [
        `schema: orcaops.evaluator_package/v1`,
        `id: ${pack.id}`,
        `name: ${pack.id}`,
        `version: 0.0.1`,
        `description: |`,
        `  Test pack for ${pack.id}.`,
      ].join('\n');
    await writeFile(path.join(packRoot, 'package.yaml'), manifestYaml, 'utf8');

    if (pack.evaluators && pack.evaluators.length > 0) {
      const evalDir = path.join(packRoot, 'evaluators');
      await mkdir(evalDir, { recursive: true });
      for (const ev of pack.evaluators) {
        await writeFile(path.join(evalDir, `${ev.id}.eval.yaml`), ev.yaml, 'utf8');
        if (ev.descriptionFile) {
          const docsDir = path.join(packRoot, 'docs');
          await mkdir(docsDir, { recursive: true });
          await writeFile(
            path.join(docsDir, ev.descriptionFile.name),
            ev.descriptionFile.content,
            'utf8'
          );
        }
      }
    }
  }
  return { repoRoot };
}

const MINIMAL_COMMAND_SPEC = [
  `schema: orcaops.evaluator/v1`,
  `id: plan-label-quality`,
  `phase: post-plan`,
  `severity: warn`,
  `description: |`,
  `  Flag generic plan labels.`,
  `engine:`,
  `  kind: command`,
  `  command: [bash, ./checks/plan_label_quality.sh]`,
  `  timeout_ms: 5000`,
].join('\n');

const MINIMAL_CONFIG = [
  `schema: orcaops.evaluator_config/v2`,
  `packages:`,
  `  - id: core`,
  `    source:`,
  `      kind: path`,
  `      path: ./.orcaops/evaluators/core`,
  `evaluators:`,
  `  core/plan-label-quality:`,
  `    enabled: true`,
].join('\n');

describe('discoverEvaluators', () => {
  let fixtures: RepoFixture[] = [];

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(async () => {
    for (const f of fixtures) {
      await rm(f.repoRoot, { recursive: true, force: true });
    }
  });

  async function build(spec: Parameters<typeof buildRepo>[0]): Promise<RepoFixture> {
    const f = await buildRepo(spec);
    fixtures.push(f);
    return f;
  }

  it('returns empty when .orcaops/evaluators.yaml is missing', async () => {
    const f = await build({ configYaml: null, packs: [] });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.evaluators).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it('returns empty when config declares no packages', async () => {
    const f = await build({
      configYaml: 'schema: orcaops.evaluator_config/v2\n',
      packs: [],
    });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.evaluators).toEqual([]);
  });

  it('rejects a repository evaluator config symlink without reading its target', async () => {
    const f = await build({ configYaml: null, packs: [] });
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'orcaops-discover-config-'));
    const outsideConfig = path.join(outsideDir, 'evaluators.yaml');
    await writeFile(outsideConfig, 'not: [valid yaml', 'utf8');
    await symlink(outsideConfig, path.join(f.repoRoot, ORCAOPS_CONFIG_DIR, 'evaluators.yaml'));

    try {
      await expect(discoverEvaluators(f.repoRoot)).rejects.toMatchObject({
        name: 'PathContainmentError',
      });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('resolves a minimal pack + spec end-to-end', async () => {
    const f = await build({
      configYaml: MINIMAL_CONFIG,
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [{ id: 'plan-label-quality', yaml: MINIMAL_COMMAND_SPEC }],
        },
      ],
    });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.errors).toEqual([]);
    expect(out.evaluators).toHaveLength(1);
    const ev = out.evaluators[0];
    expect(ev.ref).toBe('core/plan-label-quality');
    expect(ev.enabled).toBe(true);
    expect(ev.severity).toBe('warn');
    expect(ev.description).toMatch(/Flag generic plan labels/);
  });

  it('rejects an escaping prompt during production discovery', async () => {
    const escapingLlm = [
      'schema: orcaops.evaluator/v1',
      'id: escape',
      'phase: post-plan',
      'severity: warn',
      'description: hostile prompt',
      'engine:',
      '  kind: llm',
      '  additional_context_sections: []',
      '  prompt_file: ../../../../outside.md',
      '  timeout_ms: 30000',
    ].join('\n');
    const f = await build({
      configYaml: MINIMAL_CONFIG.replaceAll('plan-label-quality', 'escape'),
      packs: [{ id: 'core', dir: 'core', evaluators: [{ id: 'escape', yaml: escapingLlm }] }],
    });

    await expect(discoverEvaluators(f.repoRoot)).rejects.toMatchObject({
      code: 'path_escapes_pack',
    });
  });

  it('rejects an in-pack prompt symlink to an external file during discovery', async () => {
    const llmSpec = [
      'schema: orcaops.evaluator/v1',
      'id: linked',
      'phase: post-plan',
      'severity: warn',
      'description: hostile prompt link',
      'engine:',
      '  kind: llm',
      '  additional_context_sections: []',
      '  prompt_file: ./prompts/linked.md',
      '  timeout_ms: 30000',
    ].join('\n');
    const f = await build({
      configYaml: MINIMAL_CONFIG.replaceAll('plan-label-quality', 'linked'),
      packs: [{ id: 'core', dir: 'core', evaluators: [{ id: 'linked', yaml: llmSpec }] }],
    });
    const packRoot = path.join(f.repoRoot, '.orcaops', 'evaluators', 'core');
    const outside = path.join(f.repoRoot, 'outside.md');
    await mkdir(path.join(packRoot, 'prompts'), { recursive: true });
    await writeFile(outside, 'external secret', 'utf8');
    await symlink(outside, path.join(packRoot, 'prompts', 'linked.md'));

    await expect(discoverEvaluators(f.repoRoot)).rejects.toMatchObject({
      code: 'path_escapes_pack',
    });
  });

  it('rejects a dangling prompt symlink as a containment failure', async () => {
    const llmSpec = [
      'schema: orcaops.evaluator/v1',
      'id: linked',
      'phase: post-plan',
      'severity: warn',
      'description: dangling prompt link',
      'engine:',
      '  kind: llm',
      '  additional_context_sections: []',
      '  prompt_file: ./prompts/linked.md',
      '  timeout_ms: 30000',
    ].join('\n');
    const f = await build({
      configYaml: MINIMAL_CONFIG.replaceAll('plan-label-quality', 'linked'),
      packs: [{ id: 'core', dir: 'core', evaluators: [{ id: 'linked', yaml: llmSpec }] }],
    });
    const promptDir = path.join(f.repoRoot, '.orcaops', 'evaluators', 'core', 'prompts');
    await mkdir(promptDir, { recursive: true });
    await symlink(path.join(f.repoRoot, 'missing-prompt.md'), path.join(promptDir, 'linked.md'));

    await expect(discoverEvaluators(f.repoRoot)).rejects.toMatchObject({
      code: 'path_escapes_pack',
    });
  });

  it('rejects an evaluator_dir symlink that resolves outside the pack', async () => {
    const f = await build({
      configYaml: MINIMAL_CONFIG,
      packs: [
        {
          id: 'core',
          dir: 'core',
          manifestYaml: [
            'schema: orcaops.evaluator_package/v1',
            'id: core',
            'name: core',
            'version: 0.0.1',
            'description: hostile evaluator directory',
            'evaluator_dir: ./linked-evaluators',
          ].join('\n'),
        },
      ],
    });
    const packRoot = path.join(f.repoRoot, '.orcaops', 'evaluators', 'core');
    const outsideDir = path.join(f.repoRoot, 'outside-evaluators');
    await mkdir(outsideDir);
    await writeFile(
      path.join(outsideDir, 'plan-label-quality.eval.yaml'),
      MINIMAL_COMMAND_SPEC,
      'utf8'
    );
    await symlink(outsideDir, path.join(packRoot, 'linked-evaluators'));

    await expect(discoverEvaluators(f.repoRoot)).rejects.toMatchObject({
      code: 'path_escapes_pack',
    });
  });

  it('allows evaluator_dir to name the pack root itself', async () => {
    const f = await build({
      configYaml: MINIMAL_CONFIG,
      packs: [
        {
          id: 'core',
          dir: 'core',
          manifestYaml: [
            'schema: orcaops.evaluator_package/v1',
            'id: core',
            'name: core',
            'version: 0.0.1',
            'description: root evaluator directory',
            'evaluator_dir: .',
          ].join('\n'),
        },
      ],
    });
    const packRoot = path.join(f.repoRoot, '.orcaops', 'evaluators', 'core');
    await writeFile(
      path.join(packRoot, 'plan-label-quality.eval.yaml'),
      MINIMAL_COMMAND_SPEC,
      'utf8'
    );

    const result = await discoverEvaluators(f.repoRoot);
    expect(result.evaluators.map((evaluator) => evaluator.ref)).toEqual([
      'core/plan-label-quality',
    ]);
  });

  it('applies severity + params overrides from the repo config (replace semantics)', async () => {
    // The spec is authored at severity=block (so on_block_message is
    // allowed); the override DEMOTES to info and replaces params
    // wholesale. Promoting from warn → block via override would also
    // work at the resolver level — the schema's on_block_message
    // invariant is checked at spec-parse time only.
    const blockSpec = [
      `schema: orcaops.evaluator/v1`,
      `id: api-stability`,
      `phase: checkpoint-close`,
      `severity: block`,
      `description: API stability check.`,
      `engine:`,
      `  kind: command`,
      `  command: [bash, ./checks/api.sh]`,
      `  timeout_ms: 5000`,
      `params:`,
      `  include: ['src/**/*.py']`,
      `on_block_message: |`,
      `  Rewrite or acknowledge the breaking change.`,
    ].join('\n');
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators:`,
        `  core/api-stability:`,
        `    enabled: true`,
        `    severity: info`,
        `    params:`,
        `      verbose: true`,
      ].join('\n'),
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [{ id: 'api-stability', yaml: blockSpec }],
        },
      ],
    });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.errors).toEqual([]);
    expect(out.evaluators[0].severity).toBe('info'); // override demoted from block
    expect(out.evaluators[0].params).toEqual({ verbose: true }); // replace, not merge
  });

  it('disables an evaluator with `enabled: false` in the config', async () => {
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators:`,
        `  core/plan-label-quality:`,
        `    enabled: false`,
      ].join('\n'),
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [{ id: 'plan-label-quality', yaml: MINIMAL_COMMAND_SPEC }],
        },
      ],
    });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.evaluators[0].enabled).toBe(false);
  });

  it('treats an unlisted evaluator as `enabled: false`', async () => {
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators: {}`,
      ].join('\n'),
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [{ id: 'plan-label-quality', yaml: MINIMAL_COMMAND_SPEC }],
        },
      ],
    });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.evaluators[0].enabled).toBe(false);
  });

  it('loads description_file contents when description is omitted', async () => {
    const specYaml = [
      `schema: orcaops.evaluator/v1`,
      `id: scope-creep-detect`,
      `phase: checkpoint-close`,
      `severity: warn`,
      `description_file: ./docs/scope-creep.md`,
      `engine:`,
      `  kind: llm`,
      `  additional_context_sections: []`,
      `  prompt_file: ./prompts/scope-creep.md`,
      `  timeout_ms: 30000`,
    ].join('\n');
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators:`,
        `  core/scope-creep-detect:`,
        `    enabled: true`,
      ].join('\n'),
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [
            {
              id: 'scope-creep-detect',
              yaml: specYaml,
              descriptionFile: {
                name: 'scope-creep.md',
                content: 'Detailed description from file.',
              },
            },
          ],
        },
      ],
    });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.errors).toEqual([]);
    expect(out.evaluators[0].description).toBe('Detailed description from file.');
  });

  it('throws on malformed YAML in evaluator config (capture mode)', async () => {
    const f = await build({
      configYaml: 'this is: : not valid: yaml:\n  ::',
      packs: [],
    });
    await expect(discoverEvaluators(f.repoRoot)).rejects.toBeInstanceOf(EvaluatorDiscoveryError);
  });

  it('collects malformed-config errors in lenient mode', async () => {
    const f = await build({
      configYaml: 'this is: : not valid: yaml:\n  ::',
      packs: [],
    });
    const errors: EvaluatorDiscoveryError[] = [];
    const out = await discoverEvaluators(f.repoRoot, { onError: (e) => errors.push(e) });
    expect(out.evaluators).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(EvaluatorDiscoveryError);
  });

  it('errors when a declared pack directory has no package.yaml', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-discover-'));
    fixtures.push({ repoRoot });
    await mkdir(path.join(repoRoot, ORCAOPS_CONFIG_DIR), { recursive: true });
    await writeFile(
      path.join(repoRoot, ORCAOPS_CONFIG_DIR, 'evaluators.yaml'),
      [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
      ].join('\n'),
      'utf8'
    );
    await mkdir(path.join(repoRoot, ORCAOPS_CONFIG_DIR, 'evaluators', 'core'), {
      recursive: true,
    });
    // No package.yaml in the pack directory.
    await expect(discoverEvaluators(repoRoot)).rejects.toBeInstanceOf(EvaluatorDiscoveryError);
  });

  it("errors when package.yaml's id mismatches the config entry id", async () => {
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
      ].join('\n'),
      packs: [
        {
          id: 'core',
          dir: 'core',
          manifestYaml: [
            `schema: orcaops.evaluator_package/v1`,
            `id: not-core`,
            `name: not-core`,
            `version: 0.0.1`,
            `description: mismatched`,
          ].join('\n'),
        },
      ],
    });
    const errors: EvaluatorDiscoveryError[] = [];
    const out = await discoverEvaluators(f.repoRoot, { onError: (e) => errors.push(e) });
    expect(out.evaluators).toEqual([]);
    expect(errors.some((e) => /does not match the entry id/.test(e.message))).toBe(true);
  });

  it('errors on a schema-invalid spec (lenient mode collects it)', async () => {
    const f = await build({
      configYaml: MINIMAL_CONFIG,
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [
            {
              id: 'plan-label-quality',
              yaml: [
                `schema: orcaops.evaluator/v1`,
                `id: plan-label-quality`,
                `phase: bogus-phase`,
                `severity: warn`,
                `description: invalid phase`,
                `engine:`,
                `  kind: command`,
                `  command: [bash, x.sh]`,
                `  timeout_ms: 5000`,
              ].join('\n'),
            },
          ],
        },
      ],
    });
    const errors: EvaluatorDiscoveryError[] = [];
    const out = await discoverEvaluators(f.repoRoot, { onError: (e) => errors.push(e) });
    expect(out.evaluators).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field_path).toBe('phase');
  });

  it('rejects two specs with the same id within one pack', async () => {
    const f = await build({
      configYaml: MINIMAL_CONFIG,
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [
            { id: 'plan-label-quality', yaml: MINIMAL_COMMAND_SPEC },
            { id: 'duplicate', yaml: MINIMAL_COMMAND_SPEC },
          ],
        },
      ],
    });
    // Both files declare the same `id: plan-label-quality` inside.
    // The id check happens against the parsed YAML, not the filename.
    const errors: EvaluatorDiscoveryError[] = [];
    const out = await discoverEvaluators(f.repoRoot, { onError: (e) => errors.push(e) });
    expect(out.evaluators).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/duplicate evaluator id/);
  });

  it('invokes the injected validate_params callback with resolved params + schema', async () => {
    const specYaml = [
      `schema: orcaops.evaluator/v1`,
      `id: parametric`,
      `phase: post-plan`,
      `severity: info`,
      `description: takes params`,
      `engine:`,
      `  kind: command`,
      `  command: [bash, x.sh]`,
      `  timeout_ms: 5000`,
      `params_schema:`,
      `  type: object`,
      `  properties:`,
      `    threshold: { type: number }`,
      `  required: [threshold]`,
      `params:`,
      `  threshold: 0.6`,
    ].join('\n');
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators:`,
        `  core/parametric:`,
        `    enabled: true`,
      ].join('\n'),
      packs: [{ id: 'core', dir: 'core', evaluators: [{ id: 'parametric', yaml: specYaml }] }],
    });
    const calls: Array<{ params: unknown; schema: unknown }> = [];
    const out = await discoverEvaluators(f.repoRoot, {
      validateParams: (params, schema) => {
        calls.push({ params, schema });
      },
    });
    expect(out.errors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ threshold: 0.6 });
    expect(calls[0].schema).toMatchObject({ required: ['threshold'] });
  });

  it('rejects params that fail the spec params_schema (default ajv validator)', async () => {
    const specYaml = [
      `schema: orcaops.evaluator/v1`,
      `id: parametric`,
      `phase: post-plan`,
      `severity: info`,
      `description: needs threshold`,
      `engine:`,
      `  kind: command`,
      `  command: [bash, x.sh]`,
      `  timeout_ms: 5000`,
      `params_schema:`,
      `  type: object`,
      `  properties:`,
      `    threshold: { type: number, minimum: 0, maximum: 1 }`,
      `  required: [threshold]`,
      `params:`,
      `  threshold: 2.5`,
    ].join('\n');
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators:`,
        `  core/parametric:`,
        `    enabled: true`,
      ].join('\n'),
      packs: [{ id: 'core', dir: 'core', evaluators: [{ id: 'parametric', yaml: specYaml }] }],
    });
    const errors: EvaluatorDiscoveryError[] = [];
    const out = await discoverEvaluators(f.repoRoot, { onError: (e) => errors.push(e) });
    expect(out.evaluators).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field_path).toBe('params');
    // The stable code propagates from EvaluatorResolveError
    // through wrapResolveError onto EvaluatorDiscoveryError. Callers
    // (eval list --strict, doctor) read this code to distinguish
    // params-schema-invalid from other discovery errors.
    expect(errors[0].code).toBe('params_schema_invalid');
  });

  it('emits code=params_schema_invalid when a yaml override violates the params_schema', async () => {
    // The spec's defaults pass; the .orcaops/evaluators.yaml override
    // for the same evaluator sets an out-of-bounds threshold. The
    // resolver applies the override, ajv rejects, and the discovery
    // surface carries the structured code.
    const specYaml = [
      `schema: orcaops.evaluator/v1`,
      `id: parametric`,
      `phase: post-plan`,
      `severity: info`,
      `description: needs threshold`,
      `engine:`,
      `  kind: command`,
      `  command: [bash, x.sh]`,
      `  timeout_ms: 5000`,
      `params_schema:`,
      `  type: object`,
      `  properties:`,
      `    threshold: { type: number, minimum: 0, maximum: 1 }`,
      `  required: [threshold]`,
      `params:`,
      `  threshold: 0.5`,
    ].join('\n');
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators:`,
        `  core/parametric:`,
        `    enabled: true`,
        `    params:`,
        `      threshold: 5`,
      ].join('\n'),
      packs: [{ id: 'core', dir: 'core', evaluators: [{ id: 'parametric', yaml: specYaml }] }],
    });
    const errors: EvaluatorDiscoveryError[] = [];
    const out = await discoverEvaluators(f.repoRoot, { onError: (e) => errors.push(e) });
    expect(out.evaluators).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field_path).toBe('params');
    expect(errors[0].code).toBe('params_schema_invalid');
  });

  it('continues past one failing spec to load others in lenient mode', async () => {
    const goodSpec = [
      `schema: orcaops.evaluator/v1`,
      `id: good`,
      `phase: post-plan`,
      `severity: info`,
      `description: ok`,
      `engine:`,
      `  kind: command`,
      `  command: [bash, x.sh]`,
      `  timeout_ms: 5000`,
    ].join('\n');
    const badSpec = [
      `schema: orcaops.evaluator/v1`,
      `id: bad`,
      `phase: bogus`,
      `severity: info`,
      `description: bad phase`,
      `engine:`,
      `  kind: command`,
      `  command: [bash, x.sh]`,
      `  timeout_ms: 5000`,
    ].join('\n');
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: core`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/core`,
        `evaluators:`,
        `  core/good: { enabled: true }`,
        `  core/bad:  { enabled: true }`,
      ].join('\n'),
      packs: [
        {
          id: 'core',
          dir: 'core',
          evaluators: [
            { id: 'good', yaml: goodSpec },
            { id: 'bad', yaml: badSpec },
          ],
        },
      ],
    });
    const errors: EvaluatorDiscoveryError[] = [];
    const out = await discoverEvaluators(f.repoRoot, { onError: (e) => errors.push(e) });
    expect(out.evaluators).toHaveLength(1);
    expect(out.evaluators[0].evaluator_id).toBe('good');
    expect(errors).toHaveLength(1);
  });

  it('resolves the same evaluator id under different packs as distinct refs', async () => {
    const specA = [
      `schema: orcaops.evaluator/v1`,
      `id: shared-name`,
      `phase: post-plan`,
      `severity: info`,
      `description: from pack a`,
      `engine:`,
      `  kind: command`,
      `  command: [bash, x.sh]`,
      `  timeout_ms: 5000`,
    ].join('\n');
    const specB = specA.replace('from pack a', 'from pack b');
    const f = await build({
      configYaml: [
        `schema: orcaops.evaluator_config/v2`,
        `packages:`,
        `  - id: pack-a`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/pack-a`,
        `  - id: pack-b`,
        `    source:`,
        `      kind: path`,
        `      path: ./.orcaops/evaluators/pack-b`,
        `evaluators:`,
        `  pack-a/shared-name: { enabled: true }`,
        `  pack-b/shared-name: { enabled: true }`,
      ].join('\n'),
      packs: [
        {
          id: 'pack-a',
          dir: 'pack-a',
          evaluators: [{ id: 'shared-name', yaml: specA }],
        },
        {
          id: 'pack-b',
          dir: 'pack-b',
          evaluators: [{ id: 'shared-name', yaml: specB }],
        },
      ],
    });
    const out = await discoverEvaluators(f.repoRoot);
    expect(out.errors).toEqual([]);
    const refs = out.evaluators.map((e) => e.ref).sort();
    expect(refs).toEqual(['pack-a/shared-name', 'pack-b/shared-name']);
  });
});
