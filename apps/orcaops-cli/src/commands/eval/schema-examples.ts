/**
 * Hand-written exemplars for the two files an evaluator author types by hand.
 *
 * Hand-written on purpose, exactly like `eval test --print-example-fixture`:
 * a JSON Schema answers "is this valid", never "what do I write", and a
 * generator cannot emit the comments that carry the reasoning. A contract test
 * parses each one through its real schema, which is what keeps them honest as
 * the schemas move.
 *
 * Measured need, not a guess: a field-run agent read all three `eval schema`
 * kinds and then still opened a shipped pack to learn the layout. The guide
 * covers this too, but it ships nowhere an external author receives it — no
 * public docs site, and neither package carries it — so the CLI is the only
 * surface that travels with the tool.
 *
 * YAML, not JSON: these files are YAML on disk, so an author can paste the
 * output straight into place.
 */

/**
 * A command-engine spec. Deliberately shows the awkward parts rather than the
 * minimum — the description rule, a pack-relative command, and a
 * `params_schema` that rejects typos — because those are what authors get
 * wrong.
 */
export const SPEC_EXAMPLE = `# evaluators/plan-has-budget.eval.yaml
schema: orcaops.evaluator/v1
id: plan-has-budget
phase: post-plan
severity: warn

# Exactly one of \`description\` or \`description_file\` — neither is rejected,
# and both is rejected. Consumers read this before granting trust, so say what
# the evaluator touches.
description: >-
  Flag plans that never mention a budget. Projects with unstated cost
  expectations tend to grow scope.

engine:
  kind: command
  # Resolved against the pack root (\`engine.cwd\` defaults to \`package\`).
  command:
    - node
    - ./runtime/plan-has-budget.js
  # REQUIRED here or as \`defaults.timeout_ms\` in package.yaml. The field is
  # optional in the schema but the pack resolver demands one of the two, so a
  # spec without it validates and then fails discovery.
  timeout_ms: 30000
  env:
    # Production dispatch builds the subprocess env from an ALLOWLIST — it
    # starts empty, so without PATH the spawn dies with \`spawn node ENOENT\`.
    # The SDK's \`runFixture()\` inherits your ambient env instead, so it cannot
    # catch this; only the CLI loop will.
    inherit:
      - PATH

# Optional. Validated by ajv at discovery, so a consumer's bad override fails
# before it reaches your runtime. \`additionalProperties: false\` is what turns
# a silent typo into an error.
params_schema:
  type: object
  properties:
    tokens:
      type: array
      items: { type: string, minLength: 1 }
      minItems: 1
  required: [tokens]
  additionalProperties: false

params:
  tokens: [budget, cost, spend]
`;

/**
 * The pack manifest, carrying the directory layout in comments. The layout is
 * the part `eval schema manifest` cannot express and the part authors go
 * hunting for: the manifest declares `evaluator_dir`, but nothing in the schema
 * says where `runtime/` or `prompts/` live relative to it.
 */
export const MANIFEST_EXAMPLE = `# package.yaml — at the pack root.
#
#   my-pack/
#     package.yaml            <- this file
#     evaluators/
#       plan-has-budget.eval.yaml
#     runtime/
#       plan-has-budget.js    <- one per command-engine evaluator
#     prompts/
#       my-checker.prompt.md  <- one per llm-engine evaluator
#
schema: orcaops.evaluator_package/v1
id: my-pack
name: My Pack
version: 0.1.0
description: One line describing what this pack checks.

# Where the \`*.eval.yaml\` specs live, relative to this file.
evaluator_dir: ./evaluators
`;

/** Kinds `--example` can answer for. */
export const EXAMPLE_KINDS = ['spec', 'manifest'] as const;
export type ExampleKind = (typeof EXAMPLE_KINDS)[number];

export const SCHEMA_EXAMPLES: Record<ExampleKind, string> = {
  spec: SPEC_EXAMPLE,
  manifest: MANIFEST_EXAMPLE,
};
