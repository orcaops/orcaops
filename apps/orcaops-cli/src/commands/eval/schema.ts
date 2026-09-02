import { z } from 'zod';

import {
  EvaluatorPackageSchema,
  EvaluatorResultEnvelopeSchema,
  EvaluatorSchema,
} from '@orcaops/evaluator-protocol';

import { EXAMPLE_KINDS, type ExampleKind, SCHEMA_EXAMPLES } from './schema-examples.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';

/**
 * The author-facing shapes, keyed by the word an author types. Every file an
 * evaluator author writes by hand — plus the envelope their command engine
 * prints — has a kind here; nothing else does. `context` and `fixture` are
 * deliberately absent: `makeContext()` and `eval test --print-example-fixture`
 * are strictly better surfaces for those, and offering a worse second path is
 * how the fixture-discovery hole was dug the first time.
 */
export const SCHEMA_KINDS = {
  spec: {
    schema: EvaluatorSchema,
    /** What an author is writing when they ask for this kind. */
    writes: 'an evaluator spec (`<id>.eval.yaml`)',
  },
  manifest: {
    schema: EvaluatorPackageSchema,
    writes: 'a pack manifest (`package.yaml`)',
  },
  result: {
    schema: EvaluatorResultEnvelopeSchema,
    writes: 'the result envelope a command engine prints on stdout',
  },
} as const satisfies Record<string, { schema: z.ZodType; writes: string }>;

export type SchemaKind = keyof typeof SCHEMA_KINDS;

export const SCHEMA_KIND_NAMES = Object.keys(SCHEMA_KINDS) as SchemaKind[];

/**
 * The disclaimer stamped onto every emitted projection. It rides the artifact
 * itself rather than `--help` because the file gets piped into a generator, an
 * editor, or a model prompt, and none of those carry `--help` along.
 *
 * The claim is load-bearing and measured, not defensive boilerplate:
 * `EvaluatorSchema` carries cross-field rules in `superRefine` bodies —
 * arbitrary JavaScript that `z.toJSONSchema` cannot read — so they are dropped
 * silently. A spec orcaops rejects with three issues validates clean here.
 *
 * The gap is a GENERATION limit, not a JSON Schema one: `if`/`then`, `oneOf`,
 * and `not` express every one of these rules perfectly well. Saying otherwise
 * would misinform the author twice over — about why this file is incomplete,
 * and about what they can write in their own `params_schema`, which IS
 * hand-authored JSON Schema and is validated by ajv at discovery.
 */
export const STRUCTURAL_PROJECTION_COMMENT =
  'Structural projection only. Cross-field rules (e.g. `severity: block` requires ' +
  '`on_block_message`; `phase: checkpoint-open` requires `engine.kind: command`) live in ' +
  'refinement code this projection is generated from, so they are absent here — JSON Schema ' +
  'could express them, this generator cannot recover them. orcaops parsing and ' +
  '`orcaops eval test` are authoritative.';

/**
 * `io: 'input'` because the verb answers "what do I write in this file". The
 * `output` projection would list keys the parser FILLS IN for you (defaults,
 * prefaults) as if the author had to supply them — a wrong answer that looks
 * authoritative.
 */
export function schemaProjection(kind: SchemaKind): Record<string, unknown> {
  const projected = z.toJSONSchema(SCHEMA_KINDS[kind].schema, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return { ...projected, $comment: STRUCTURAL_PROJECTION_COMMENT };
}

export interface EvalSchemaOptions {
  kind: string;
  /**
   * Print a hand-written exemplar of the FILE instead of its JSON Schema.
   * Only the two shapes an author types by hand answer to this; see
   * `schema-examples.ts` for why it is hand-written rather than generated.
   */
  example?: boolean;
}

/**
 * Print the generated JSON Schema for one author-facing shape.
 *
 * Read-only by construction: no repo context, no config read, no archive
 * identity — the same boundary `eval test` sits on. An author reaching for a
 * shape has often not run `orcaops init` yet, and needing a configured
 * repository to see what a file looks like is exactly the friction this verb
 * exists to remove.
 *
 * Emits JSON unconditionally; a JSON Schema has no human rendering. `--json` is
 * accepted as a no-op alias so the flag every sibling verb takes is not an
 * error here.
 */
export function evalSchemaAction(opts: EvalSchemaOptions): void {
  try {
    if (!isSchemaKind(opts.kind)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `unknown schema kind "${opts.kind}" — expected one of: ${SCHEMA_KIND_NAMES.join(', ')}.`,
        'kind'
      );
    }
    if (opts.example) {
      if (!isExampleKind(opts.kind)) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--example has no answer for "${opts.kind}" — you never hand-write that shape. ` +
            (opts.kind === 'result'
              ? 'A result envelope is constructed by `pass()` / `violation()` / `info()` from ' +
                '@orcaops/evaluator-sdk. '
              : '') +
            `Exemplars exist for: ${EXAMPLE_KINDS.join(', ')}.`,
          'example'
        );
      }
      writeTerminalSafeStdout(SCHEMA_EXAMPLES[opts.kind]);
      return;
    }
    writeTerminalSafeStdout(`${JSON.stringify(schemaProjection(opts.kind), null, 2)}\n`);
  } catch (err) {
    if (err instanceof CliExit) throw err;
    // stderr first, then the JSON envelope on stdout: the verb's stdout
    // contract is JSON either way, and `emitError` throws the exit itself.
    writeErrorLine(err);
    emitError(err);
  }
}

function isSchemaKind(kind: string): kind is SchemaKind {
  return Object.hasOwn(SCHEMA_KINDS, kind);
}

function isExampleKind(kind: string): kind is ExampleKind {
  return Object.hasOwn(SCHEMA_EXAMPLES, kind);
}
