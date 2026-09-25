import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  EvaluatorPackageSchema,
  EvaluatorResultEnvelopeV2Schema,
  EvaluatorSchema,
} from '@orcaops/evaluator-protocol';

import { EXAMPLE_KINDS, RESULT_ENVELOPE_EXAMPLE, SCHEMA_EXAMPLES } from './schema-examples.js';
import {
  SCHEMA_KIND_NAMES,
  SCHEMA_KINDS,
  type SchemaKind,
  schemaProjection,
  STRUCTURAL_PROJECTION_COMMENT,
} from './schema.js';

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..'
);

/**
 * The exemplars are hand-written, so nothing but a test keeps them valid.
 *
 * Parsing each file through its schema is NOT enough, and shipping proved it: a
 * field run pasted these exemplars and hit two walls the parse assertions slept
 * through — a missing `timeout_ms` (optional in the schema, required by the pack
 * resolver across spec ∪ manifest defaults) and a missing `env.inherit: [PATH]`
 * (production builds the subprocess env from an allowlist). Both files were
 * individually valid the whole time.
 *
 * So the load-bearing case is `assembles into a pack that discovers and
 * dispatches` below. The per-file parses remain as fast, precise failure
 * localizers when it goes red.
 */
describe('eval schema --example exemplars', () => {
  it('the spec exemplar parses through EvaluatorSchema', () => {
    const parsed = EvaluatorSchema.safeParse(parseYaml(SCHEMA_EXAMPLES.spec));
    if (!parsed.success) {
      throw new Error(`spec exemplar is invalid:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.data.id).toBe('plan-has-budget');
    // It must satisfy the cross-field rules too, not merely the structure —
    // those are exactly what the JSON Schema projection cannot check.
    expect(parsed.data.description).toBeTruthy();
    expect(parsed.data.description_file).toBeUndefined();
  });

  it('the manifest exemplar parses through EvaluatorPackageSchema', () => {
    const parsed = EvaluatorPackageSchema.safeParse(parseYaml(SCHEMA_EXAMPLES.manifest));
    if (!parsed.success) {
      throw new Error(
        `manifest exemplar is invalid:\n${JSON.stringify(parsed.error.issues, null, 2)}`
      );
    }
    expect(parsed.data.evaluator_dir).toBe('./evaluators');
  });

  it('carries the layout the schema cannot express', () => {
    // The field-run gap: the schema says where specs live via `evaluator_dir`,
    // but nothing says where `runtime/` and `prompts/` sit beside it.
    expect(SCHEMA_EXAMPLES.manifest).toContain('runtime/');
    expect(SCHEMA_EXAMPLES.manifest).toContain('prompts/');
    expect(SCHEMA_EXAMPLES.manifest).toContain('.eval.yaml');
  });

  it('offers exemplars only for the shapes an author hand-writes', () => {
    expect([...EXAMPLE_KINDS].sort()).toEqual(['manifest', 'spec']);
    expect(Object.keys(SCHEMA_EXAMPLES).sort()).toEqual(['manifest', 'spec']);
    // `result` has a schema kind but no exemplar: pass()/violation() build it.
    expect(SCHEMA_KIND_NAMES).toContain('result');
    expect(Object.hasOwn(SCHEMA_EXAMPLES, 'result')).toBe(false);
  });
});

describe('eval schema projections', () => {
  it('every kind converts, and none of them smuggles in a cross-field construct', () => {
    for (const kind of SCHEMA_KIND_NAMES) {
      const projected = schemaProjection(kind);
      expect(projected.type, kind).toBe('object');
      expect(projected.properties, kind).toBeTypeOf('object');
      // The projection is structural precisely BECAUSE these are absent. If a
      // future zod release starts emitting them, the `$comment` disclaimer is
      // understating what the file can check and this test should be revisited.
      const serialized = JSON.stringify(projected);
      for (const construct of ['"if"', '"then"', '"allOf"', '"not"']) {
        expect(serialized.includes(construct), `${kind} contains ${construct}`).toBe(false);
      }
    }
  });

  it('projects the INPUT shape — keys the parser fills in are not demanded of the author', () => {
    // `default_enabled` / `params` / `filters` all carry defaults, so `io:
    // output` would list them as required. Requiring an author to write keys
    // the loader supplies is the wrong answer this option exists to avoid.
    const spec = schemaProjection('spec');
    expect(spec.required).toEqual(['schema', 'id', 'phase', 'severity', 'engine']);

    const manifest = schemaProjection('manifest');
    expect(manifest.required).toEqual(['schema', 'id', 'name', 'version', 'description']);
    expect(manifest.required).not.toContain('evaluator_dir');
  });

  it('stamps the structural disclaimer on the artifact itself, not just --help', () => {
    for (const kind of SCHEMA_KIND_NAMES) {
      const comment = schemaProjection(kind).$comment;
      expect(comment, kind).toBeTypeOf('string');
      expect(comment as string, kind).toContain('Structural projection only');
      expect(comment as string, kind).toContain('orcaops eval test');
      expect(comment as string, kind).toContain('authoritative');
    }
  });

  it('names a cross-field rule the projection drops, so the claim is checkable', () => {
    const comment = schemaProjection('spec').$comment as string;
    expect(comment).toContain('on_block_message');
    expect(comment).toContain('checkpoint-open');
  });

  it('the envelope carries the findings rules its shape cannot state', () => {
    // The projection shows that `findings` exists and what it looks like. What
    // it costs, and what it may never do, is what decides whether an author
    // reaches for it correctly — and none of that is a structure.
    const comment = schemaProjection('result').$comment as string;
    expect(comment).toContain('never decides the gate');
    expect(comment).toContain('`conclusion` requires at least one expectation location');
    expect(comment).toContain('cost the findings and never the verdict');
  });

  it('the envelope carries a filled-in example that its own schema accepts', () => {
    const examples = schemaProjection('result').examples as unknown[];
    expect(examples).toEqual([RESULT_ENVELOPE_EXAMPLE]);
    const parsed = EvaluatorResultEnvelopeV2Schema.safeParse(examples[0]);
    if (!parsed.success) {
      throw new Error(
        `the result exemplar is invalid:\n${JSON.stringify(parsed.error.issues, null, 2)}`
      );
    }
    // It has to show the distinction the shape allows and the prose describes:
    // a graded expectation with an identity, and a plain observation with
    // neither. One finding would leave the second half undemonstrated.
    const findings = parsed.data.findings ?? [];
    expect(findings).toHaveLength(2);
    expect(findings[0]!.conclusion).toBe('contradicted');
    expect(findings[0]!.key).toBeTypeOf('string');
    expect(findings[0]!.locations?.some((l) => l.kind === 'acceptance-criterion')).toBe(true);
    expect(findings[1]!.key).toBeUndefined();
    expect(findings[1]!.conclusion).toBeUndefined();
    expect(findings[1]!.locations).toBeUndefined();
  });

  it('the file shapes carry the disclaimer alone — no prose, no example', () => {
    for (const kind of ['spec', 'manifest'] as const) {
      expect(schemaProjection(kind).$comment, kind).toBe(STRUCTURAL_PROJECTION_COMMENT);
      expect(schemaProjection(kind).examples, kind).toBeUndefined();
    }
  });
});

/**
 * DRIFT GUARD. An author-facing shape is one the runner parses out of content
 * the AUTHOR wrote — their spec files, their manifest, their engine's stdout.
 * Each of those needs a `schema` kind, or the verb quietly stops answering
 * "what do I write here" for one of them.
 *
 * Derived from the runner source rather than restated, because a restated list
 * is exactly what goes stale. `context` is excluded by construction: it is
 * built FOR the evaluator, never written by one.
 */
describe('every author-facing schema has a kind', () => {
  const AUTHOR_PARSED_DIRS = ['discovery', 'engines'];
  const SCHEMA_REF_RE = /\b(Evaluator[A-Za-z]*Schema)\.(?:safeParse|parse)\(/g;

  /**
   * Readers that validate author content without naming a schema at the call
   * site, mapped to the schema they validate with. The result envelope stopped
   * being a `Schema.parse(` call when the runner moved to `readResultEnvelope`,
   * which reads the envelope and its findings in two steps — so a name-only
   * scan silently stopped covering the one shape every producer emits.
   */
  const READER_SCHEMAS = new Map<string, string>([
    ['readResultEnvelope', 'EvaluatorResultEnvelopeV2Schema'],
  ]);
  const READER_RE = new RegExp(`\\b(${[...READER_SCHEMAS.keys()].join('|')})\\(`, 'g');

  /** Schemas the scan reaches that are deliberately not author-facing. */
  const EXCLUDED = new Map<string, string>([
    [
      'EvaluatorConfigSchema',
      'the CONSUMER-side `.orcaops/config.yaml` evaluators block — written by the repo ' +
        'installing a pack, never by the pack author, and already owned by `eval add-pack` / ' +
        '`eval enable`',
    ],
  ]);

  it('every schema the runner parses author content with is reachable by kind', async () => {
    const runnerSrc = path.join(REPO_ROOT, 'packages', 'evaluator-runner', 'src');
    const found = new Set<string>();
    for (const dir of AUTHOR_PARSED_DIRS) {
      const abs = path.join(runnerSrc, dir);
      for (const entry of await readdir(abs, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
          continue;
        }
        const text = await readFile(path.join(abs, entry.name), 'utf8');
        for (const match of text.matchAll(SCHEMA_REF_RE)) found.add(match[1]);
        for (const match of text.matchAll(READER_RE)) found.add(READER_SCHEMAS.get(match[1])!);
      }
    }

    // The guard is worthless if the scan matched nothing, and worth less than
    // it looks if it missed the shape the readers hide.
    expect(found.size).toBeGreaterThan(0);
    expect([...found]).toContain('EvaluatorResultEnvelopeV2Schema');

    const covered = new Set(SCHEMA_KIND_NAMES.map((kind: SchemaKind) => schemaIdentityName(kind)));
    const uncovered = [...found].filter((name) => !covered.has(name) && !EXCLUDED.has(name)).sort();
    expect(uncovered).toEqual([]);
  });

  /**
   * Resolve a kind back to the exported schema NAME, so the scan above can be
   * compared against source text. Identity comparison against the imported
   * bindings would be tautological; the name is what the source shows.
   */
  function schemaIdentityName(kind: SchemaKind): string {
    return {
      spec: 'EvaluatorSchema',
      manifest: 'EvaluatorPackageSchema',
      result: 'EvaluatorResultEnvelopeV2Schema',
    }[kind];
  }

  it('the kind table and its name mapping stay in step', () => {
    expect(SCHEMA_KIND_NAMES.sort()).toEqual(['manifest', 'result', 'spec']);
    expect(Object.keys(SCHEMA_KINDS).sort()).toEqual(SCHEMA_KIND_NAMES.sort());
  });
});
