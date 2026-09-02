import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orcaopsAuthorEvaluatorSkill as builtSkill } from '@orcaops/adapters';
import {
  EvaluatorContextSchema,
  EvaluatorPackageSchema,
  EvaluatorPhaseSchema,
  EvaluatorResultEnvelopeSchema,
  EvaluatorSchema,
} from '@orcaops/evaluator-protocol';
import * as protocol from '@orcaops/evaluator-protocol';
import * as sdk from '@orcaops/evaluator-sdk';
import { FixtureFileSchema } from '@orcaops/storage';

import { buildProgram } from '../../src/cli/program.js';

const BODY = typeof builtSkill.body === 'function' ? builtSkill.body('orcaops') : builtSkill.body;

/**
 * The authored template, read as TEXT rather than imported.
 *
 * `@orcaops/adapters` resolves to `dist/`, so every assertion here grades the
 * last BUILD — a skill-body edit without a rebuild would read as green.
 * Importing the source module instead pulls another package into this project's
 * TS program and fails `typecheck:tests` with TS6059 (rootDir). Reading the file
 * keeps the staleness protection with no build-graph coupling.
 */
const SOURCE_TEXT = readFileSync(
  path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../../packages/adapters/src/skills/orcaops-author-evaluator.ts'
  ),
  'utf8'
);

/**
 * Anchors are matched against the body with whitespace collapsed. The body is
 * hard-wrapped prose, so a sentence-length anchor would otherwise be pinned to
 * the column a phrase happens to break at — a reflow would fail the guard while
 * the rule is still taught, which trains people to loosen the anchors.
 */
const FLAT_BODY = BODY.replace(/\s+/g, ' ');

/**
 * The stale-build gate. Every assertion below reads the BUILT body; the
 * authored file is what a reviewer edits. If a guarded string is present in one
 * and absent from the other, this suite is grading a file nobody ships — so
 * name that, rather than letting a targeted `vitest run` pass over a build that
 * is hours old.
 *
 * Checked against the strings the guards actually depend on, not the whole
 * body: source is TypeScript with escapes and interpolation, so a literal
 * whole-text comparison would fail on formatting rather than drift.
 */
describe('the built adapters output matches the authored source', () => {
  it('rebuild @orcaops/adapters if this fails', () => {
    // The body is a template literal, so every backtick is escaped in source.
    const flatSource = SOURCE_TEXT.replace(/\\`/g, '`').replace(/\s+/g, ' ');
    const guarded = [
      ...EvaluatorPhaseSchema.options.map((p) => `\`${p}\``),
      ...REFINEMENT_RULES.flatMap((r) => r.anchors),
    ];
    const drifted = guarded.filter(
      (needle) => flatSource.includes(needle) !== FLAT_BODY.includes(needle)
    );
    expect(drifted).toEqual([]);
    // Non-vacuity: the needles must actually be found, not merely agree by
    // being absent from both.
    expect(guarded.every((needle) => FLAT_BODY.includes(needle))).toBe(true);
  });
});

/**
 * REFINEMENT CONTRACT. `EvaluatorSchema` states its cross-field rules as
 * `superRefine` bodies — opaque JavaScript to the schema generator, which drops
 * every one of them silently. (JSON Schema itself could express them; the
 * generator just cannot read them out of a function.) That leaves the skill
 * body as the ONLY place an author learns them —
 * and a body that quietly loses one leaves an author with a spec that validates
 * against the projection and is rejected by orcaops.
 *
 * Each row therefore asserts BOTH halves: orcaops rejects the invalid spec, and
 * the body still teaches the rule. Rejection alone is already covered by
 * `spec.test.ts`; a test that only re-proves it stays green while the skill
 * goes silent, which is the failure this table exists to catch.
 *
 * Five rules, six branches — `description` fails by supplying neither or both.
 */
const VALID_ENGINE = { kind: 'command', command: ['node', './runtime/x.js'] } as const;
const VALID_SPEC = {
  schema: 'orcaops.evaluator/v1',
  id: 'x',
  phase: 'post-plan',
  severity: 'warn',
  description: 'a description',
  engine: VALID_ENGINE,
} as const;

interface RefinementRule {
  /** Stable id, so a row can be cited without depending on its position. */
  rule: string;
  /** A spec that differs from `VALID_SPEC` only by breaking this one rule. */
  invalid: Record<string, unknown>;
  /** Where the parser reports it. */
  issuePath: string;
  /** Substrings the body must carry for an author to learn the rule. */
  anchors: string[];
}

const REFINEMENT_RULES: RefinementRule[] = [
  {
    rule: 'checkpoint-open-requires-command-engine',
    invalid: {
      ...VALID_SPEC,
      phase: 'checkpoint-open',
      engine: {
        kind: 'llm',
        prompt_file: 'prompts/x.prompt.md',
        additional_context_sections: [],
      },
    },
    issuePath: 'engine.kind',
    anchors: ['`phase: checkpoint-open` requires `engine.kind: command`'],
  },
  {
    rule: 'block-requires-on-block-message',
    invalid: { ...VALID_SPEC, severity: 'block' },
    issuePath: 'on_block_message',
    anchors: ['**`severity: block` requires `on_block_message`**'],
  },
  {
    rule: 'non-block-forbids-on-block-message',
    invalid: { ...VALID_SPEC, severity: 'warn', on_block_message: 'do the thing' },
    issuePath: 'on_block_message',
    anchors: ['**Every other severity FORBIDS `on_block_message`.**'],
  },
  {
    rule: 'description-required',
    invalid: (() => {
      const { description: _dropped, ...rest } = VALID_SPEC;
      return rest;
    })(),
    issuePath: 'description',
    anchors: ['Exactly one of `description` or `description_file`', 'Neither is rejected'],
  },
  {
    rule: 'description-exclusive',
    invalid: { ...VALID_SPEC, description_file: './description.md' },
    issuePath: 'description_file',
    anchors: ['Exactly one of `description` or `description_file`', 'both is rejected'],
  },
  {
    rule: 'json-output-requires-schema',
    invalid: {
      ...VALID_SPEC,
      engine: {
        kind: 'llm',
        prompt_file: 'prompts/x.prompt.md',
        output_format: 'json',
        additional_context_sections: [],
      },
    },
    issuePath: 'engine.output_schema',
    anchors: ['**`output_format: json` requires `output_schema`.**'],
  },
];

/**
 * PHASE DRIFT. The body shipped a four-row phase table against a five-member
 * enum, silently hiding `post-plan-revision` and the `prior_plan` context only
 * it carries. Nothing tied the prose to the enum, so nothing noticed.
 *
 * Same class of guard as the identifier resolver, applied to the one enum it
 * did not cover.
 */
describe('the phase table covers every phase that exists', () => {
  it('every EvaluatorPhaseSchema member is named in the body', () => {
    const phases = EvaluatorPhaseSchema.options;
    expect(phases.length).toBeGreaterThanOrEqual(5);
    const unnamed = phases.filter((phase) => !FLAT_BODY.includes(`\`${phase}\``));
    expect(unnamed).toEqual([]);
  });

  it("filters are taught by provenance, not by the field run's false premise", () => {
    // The field agent believed changed_files empties on snapshot failure and
    // worked around it by unioning in files_changed. Both are wrong:
    // evaluator-bridge.ts derives changed_files FROM the declared
    // files_changed, so at checkpoint-close they are the same list.
    for (const phase of ['post-plan', 'post-plan-revision', 'checkpoint-open']) {
      expect(FLAT_BODY, `${phase} must be named as empty`).toMatch(
        new RegExp(`empty at[^.]*\`${phase}\``)
      );
    }
    expect(FLAT_BODY).toContain('**declared** `files_changed`');
    expect(FLAT_BODY).toContain('not a diff orcaops computed');
    // The premise that must never reappear.
    expect(FLAT_BODY).not.toMatch(/snapshot/i);
  });

  it('the revision-only context field is taught with its null rule', () => {
    // `prior_plan` is null at every other phase AND at revision 0, which is
    // exactly the shape an author assumes away.
    expect(FLAT_BODY).toContain('`prior_plan`');
    expect(FLAT_BODY).toContain('`revision_n` is 0');
    expect(EvaluatorContextSchema.shape.prior_plan.safeParse(null).success).toBe(true);
  });
});

describe('cross-field rules the emitted schema drops', () => {
  it('the valid baseline parses, so each row differs by exactly one broken rule', () => {
    expect(EvaluatorSchema.safeParse(VALID_SPEC).success).toBe(true);
  });

  for (const { rule, invalid, issuePath, anchors } of REFINEMENT_RULES) {
    it(`${rule}: orcaops rejects it AND the skill body teaches it`, () => {
      const parsed = EvaluatorSchema.safeParse(invalid);
      expect(parsed.success, `${rule} should be rejected`).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues.map((i) => i.path.join('.'))).toContain(issuePath);

      for (const anchor of anchors) {
        expect(FLAT_BODY, `${rule}: body must carry "${anchor}"`).toContain(anchor);
      }
    });
  }

  it('the table covers every branch, and none of it is expressible in the projection', () => {
    expect(REFINEMENT_RULES).toHaveLength(6);
    expect(new Set(REFINEMENT_RULES.map((r) => r.rule)).size).toBe(6);
    // The premise. If a zod release ever emits these, the body could stop
    // carrying them — until then it is the only teacher.
    const projected = JSON.stringify(z.toJSONSchema(EvaluatorSchema, { io: 'input' }));
    for (const construct of ['"if"', '"then"', '"allOf"', '"not"']) {
      expect(projected.includes(construct)).toBe(false);
    }
  });
});

/**
 * IDENTIFIER DRIFT. The skill points at shapes instead of copying them, which
 * only stays true if every name it points AT still exists. Four backticked
 * forms are unambiguous enough to resolve mechanically:
 *
 *   `SomethingSchema`   → an export of `@orcaops/evaluator-protocol`
 *   `--some-flag`       → a flag the CLI actually parses
 *   `someHelper()`      → an export of the SDK or the protocol
 *   `some_key`          → a key of an author-facing or author-read schema
 *
 * Everything else in backticks is prose (`orcaops eval test`, `PASS`,
 * `command`) and is deliberately not checked. The non-vacuity assertions below
 * are what keep that boundary from quietly swallowing the whole body.
 */
describe('every identifier the skill body names resolves', () => {
  const backticked = [...BODY.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

  const schemaNames = backticked.filter((t) => /^[A-Z][A-Za-z]*Schema$/.test(t));
  const flags = backticked.filter((t) => /^--[a-z][a-z0-9-]*$/.test(t));
  const calls = backticked.filter((t) => /^[a-z][A-Za-z0-9]*\(\)$/.test(t));
  const snakeKeys = backticked.filter((t) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t));

  /** Every property name reachable in a JSON Schema projection, recursively. */
  function collectKeys(node: unknown, into: Set<string>): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collectKeys(item, into);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const name of Object.keys(value as object)) into.add(name);
      }
      collectKeys(value, into);
    }
  }

  const knownKeys = new Set<string>();
  for (const schema of [
    EvaluatorSchema,
    EvaluatorPackageSchema,
    EvaluatorResultEnvelopeSchema,
    EvaluatorContextSchema,
    FixtureFileSchema,
  ]) {
    collectKeys(z.toJSONSchema(schema, { io: 'input' }), knownKeys);
  }

  const knownFlags = new Set<string>();
  {
    const program = buildProgram({ cloudBaseUrl: 'https://example.invalid' });
    const walk = (command: {
      options: ReadonlyArray<{ flags: string }>;
      commands: ReadonlyArray<unknown>;
    }): void => {
      for (const option of command.options) {
        for (const token of option.flags.match(/--[a-z][a-z0-9-]*/g) ?? []) knownFlags.add(token);
      }
      for (const sub of command.commands) walk(sub as Parameters<typeof walk>[0]);
    };
    walk(program as unknown as Parameters<typeof walk>[0]);
  }

  const exports = new Set([...Object.keys(sdk), ...Object.keys(protocol)]);

  it('names schemas that are exported from the protocol package', () => {
    expect(schemaNames.length).toBeGreaterThanOrEqual(3);
    for (const name of schemaNames) {
      expect(Object.keys(protocol), name).toContain(name);
    }
  });

  it('names flags the CLI actually parses', () => {
    expect(flags.length).toBeGreaterThanOrEqual(3);
    for (const flag of flags) {
      expect([...knownFlags], flag).toContain(flag);
    }
  });

  it('names helpers the SDK or protocol actually exports', () => {
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect([...exports], call).toContain(call.slice(0, -2));
    }
  });

  it('names snake_case keys that exist on a real schema', () => {
    expect(snakeKeys.length).toBeGreaterThanOrEqual(8);
    const unresolved = [...new Set(snakeKeys)].filter((key) => !knownKeys.has(key)).sort();
    expect(unresolved).toEqual([]);
  });

  it('the classifier is not vacuous — a planted bad name in each class is caught', () => {
    // Proves the four patterns actually select, so a body that renamed
    // something could not slip past by being unrecognized.
    expect(/^[A-Z][A-Za-z]*Schema$/.test('NotARealSchema')).toBe(true);
    expect(exports.has('NotARealSchema')).toBe(false);
    expect(/^--[a-z][a-z0-9-]*$/.test('--not-a-flag')).toBe(true);
    expect(knownFlags.has('--not-a-flag')).toBe(false);
    expect(/^[a-z][A-Za-z0-9]*\(\)$/.test('notAHelper()')).toBe(true);
    expect(exports.has('notAHelper')).toBe(false);
    expect(/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test('not_a_key')).toBe(true);
    expect(knownKeys.has('not_a_key')).toBe(false);
  });
});
