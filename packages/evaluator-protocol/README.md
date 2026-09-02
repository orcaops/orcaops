# @orcaops/evaluator-protocol

The package protocol for orcaops evaluators. Pure types, Zod schemas, a
spec → resolved transform, and a picomatch-based glob helper. No fs, no
network, no subprocess machinery — that lives in `@orcaops/evaluator-runner`.

This package is the contract between core (which knows nothing about
specific checks) and packs (which ship the actual opinions). Anything
that touches an evaluator file — the runner, the cloud SDK, doctor
checks, and CLI evaluator discovery commands such as `eval list` and
`eval show` — depends on this package and on no other piece of the
evaluator subsystem.

This README is the API reference.

## Surfaces

| Surface                                                   | Export                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Repo evaluator config (`.orcaops/evaluators.yaml`)        | `EvaluatorConfigSchema`                              |
| Pack manifest (`package.yaml`)                            | `EvaluatorPackageSchema`                             |
| Evaluator spec (`*.eval.yaml`)                            | `EvaluatorSchema`                                    |
| Lifecycle context handed to evaluators                    | `EvaluatorContextSchema`                             |
| Persisted evaluator run                                   | `EvaluatorRunPayloadSchema`                          |
| Persisted disposition                                     | `EvaluatorDispositionPayloadSchema`                  |
| Structured command/LLM output envelope                    | `EvaluatorResultEnvelopeSchema`                      |
| Embedded gate audit on `checkpoint_opened`                | `GateAuditPayloadSchema`                             |
| Merged immutable view                                     | `ResolvedEvaluator` + `resolveEvaluator()`           |
| Glob matching for `filters.paths` / `fingerprint.include` | `matchesAnyGlob`, `isValidGlobSyntax`, `toPosixPath` |

Every Zod schema exports its `.infer`'d type with the same name minus
the `Schema` suffix (e.g. `EvaluatorConfig`, `EvaluatorPackage`,
`Evaluator`, `EvaluatorContext`, `EvaluatorRunPayload`,
`EvaluatorDispositionPayload`, `EvaluatorResultEnvelope`,
`GateAuditRun`, `GateAuditDisposition`, `GateAuditPayload`).

## Cross-field invariants (parse-time)

The schemas enforce every invariant that can be decided from the spec
alone:

- `severity: block` ⇒ `on_block_message` required; absent on non-block.
- `phase: checkpoint-open` ⇒ `engine.kind: command` (no LLM at open).
- Exactly one of `description` / `description_file` (inline xor path).
- `engine.kind: llm` AND `output_format: json` ⇒ `output_schema` required.
- `engine.command` is a string array (never a shell string).
- All `filters.paths[]` and `fingerprint.include[]` patterns are valid
  globs (compiled via `picomatch.makeRe`).
- `run_status: completed` ⇒ `verdict` non-null AND `error` absent.
- `run_status: error` ⇒ `verdict: null` AND `error` set.
- `run_status: skipped` ⇒ `verdict: null` AND `error` absent.
- `GateAuditRun.phase === 'checkpoint-open'` (the audit is always
  produced by the open-gate dry-run).
- Disposition payloads only carry `acknowledged | dismissed |
policy-excepted` — `unresolved` is materialized-only, never written.
- All `.strict()` — unknown keys at any layer are rejected with the
  offending field path.

Cross-source invariants (manifest defaults, repo config overrides,
`params` validation, ref uniqueness) are enforced by
`resolveEvaluator()` and `assertUniqueRefs()` in `resolve.ts`. The
resolution layer throws `EvaluatorResolveError` with `spec_path` and
`field_path` so downstream consumers can surface a precise diagnostic.

## Resolution pipeline

`resolveEvaluator()` is a pure transform. Inputs:

```ts
interface ResolveEvaluatorInput {
  spec: Evaluator; // parsed *.eval.yaml
  package_manifest: EvaluatorPackage; // parsed package.yaml
  package_root: string; // absolute path
  spec_path: string; // absolute path
  description: string; // caller resolves inline or description_file
  override?: EvaluatorOverride; // from .orcaops/evaluators.yaml
  validate_params?: (params, schema) => void; // injected JSON Schema validator
}
```

Output is a `ResolvedEvaluator` carrying:

- `ref`, `package_id`, `evaluator_id`, `package_root`, `spec_path`.
- Engine config with `timeout_ms` filled in from manifest defaults
  when the spec is silent; an `EvaluatorResolveError` if neither
  source supplies it.
- `engine.command[0]` resolved against the pack root iff it begins
  with `./` or `../`. Bare commands (PATH-resolved at exec time) and
  absolute paths pass through unchanged.
- `engine.prompt_file` (LLM engines) joined against the pack root iff
  relative.
- `env.inherit` / `env.set` cascading manifest defaults → spec; spec
  fully replaces manifest when present (so an explicit empty
  `inherit: []` means "inherit nothing", not "use manifest default").
- `params` after override (replace semantics — params is one atomic
  value, not a deep merge).
- `severity` after override.
- `fingerprint_include` carried as un-expanded glob patterns — the
  runner expands them against the disk during fingerprint
  computation.
- `enabled` — true iff the override entry sets `enabled: true`;
  false when no override entry exists.

`validate_params` is injected by the runner package (ajv-backed). The
protocol package itself has no JSON Schema validator dependency.

## Glob matching

```ts
matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean
isValidGlobSyntax(pattern: string): boolean
toPosixPath(filePath: string): string
```

Both matchers POSIX-normalize the input path (backslashes → forward
slashes) so the same `src/**/*.py` pattern matches on Windows agents.
`dot: true` is set, so a leading-dot file matches a non-leading-dot
pattern (e.g. `src/*.js` matches `src/.eslintrc.js`). Empty pattern
arrays return `false` — callers wanting "no filter" semantics treat an
empty array as "no gating," not "match everything."

## Versioning

Each schema is pinned to a `schema:` literal (`orcaops.evaluator/v1`,
`orcaops.evaluator_package/v1`, etc.). Adding new optional fields is
non-breaking. Renames, removals, or changes to invariants bump the
schema constant; the v0 schema does not exist.

## Scope

The protocol package owns:

- All Zod schemas + their inferred types.
- The `ResolvedEvaluator` shape and the pure spec → resolved
  transform.
- The picomatch glob helper.
- An `EvaluatorResolveError` with structured fields.

The protocol package does NOT own:

- Loading specs from disk (the runner's discovery stage).
- Running evaluators (the runner's engines).
- Writing events or projections (the storage package).
- Picking a pack source for `add-pack` (the CLI).
- A JSON Schema validator for user params (injected by the runner).

This separation is intentional.
