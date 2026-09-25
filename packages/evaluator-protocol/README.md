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

| Surface                                                   | Export                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| Repo evaluator config (`.orcaops/evaluators.yaml`)        | `EvaluatorConfigSchema`                                             |
| Pack manifest (`package.yaml`)                            | `EvaluatorPackageSchema`                                            |
| Evaluator spec (`*.eval.yaml`)                            | `EvaluatorSchema`                                                   |
| Lifecycle context handed to evaluators                    | `EvaluatorContextSchema`                                            |
| Persisted evaluator run                                   | `EvaluatorRunPayloadSchema`                                         |
| Persisted disposition                                     | `EvaluatorDispositionPayloadSchema`                                 |
| Structured command/LLM output envelope                    | `EvaluatorResultEnvelopeV2Schema`                                   |
| Superseded envelope, until the SDK and packs move         | `EvaluatorResultEnvelopeSchema`                                     |
| One structured finding                                    | `EvaluatorFindingSchema`                                            |
| Optional markdown findings block                          | `parseFindingsBlock`                                                |
| Two-step read of a current envelope                       | `readResultEnvelope`                                                |
| Truncation bounds and their notice                        | `boundEvaluatorFindings`                                            |
| Findings handed to storage for one run                    | `EvaluatorRunFindingsSchema`                                        |
| Findings that could not be read                           | `EvaluatorFindingsUnreadableSchema`                                 |
| Envelope version negotiation                              | `inspectResultEnvelopeProtocol`, `unsupportedResultProtocolMessage` |
| Embedded gate audit on `checkpoint_opened`                | `GateAuditPayloadSchema`                                            |
| Merged immutable view                                     | `ResolvedEvaluator` + `resolveEvaluator()`                          |
| Glob matching for `filters.paths` / `fingerprint.include` | `matchesAnyGlob`, `isValidGlobSyntax`, `toPosixPath`                |

Every Zod schema exports its `.infer`'d type with the same name minus
the `Schema` suffix (e.g. `EvaluatorConfig`, `EvaluatorPackage`,
`Evaluator`, `EvaluatorContext`, `EvaluatorRunPayload`,
`EvaluatorDispositionPayload`, `EvaluatorResultEnvelope`,
`EvaluatorResultEnvelopeV2`, `EvaluatorFinding`,
`EvaluatorFindingLocation`, `EvaluatorFindingsBlock`,
`EvaluatorRunFindings`, `EvaluatorFindingsUnreadable`,
`EvaluatorFindingsNotice`, `GateAuditRun`, `GateAuditDisposition`,
`GateAuditPayload`).

## Findings

A finding is one factual statement an evaluator makes about the work it
inspected: a `title`, an optional `detail`, an optional `key`, optional
`locations`, and an optional `conclusion` about the expectation it
points at. Every location is optional — a qualitative finding points at
nothing — and `key` is present only when the producer can name the same
thing the same way on a later run, so that a rerun is recognisable
without anyone inventing an identity for it. Storage recognises a
recurrence as `(artifact_id, evaluator_ref, key)`, never across
artifacts.

Findings never decide the gate, on any path:

- `verdict` and `severity` are the only inputs to
  `isBlockingEligibleViolation`, and a valid result may carry no findings
  under any verdict.
- Quantity bounds truncate rather than refuse. `boundEvaluatorFindings`
  applies them and returns a notice counting what it cut, so a
  hundred-and-first finding can never turn a dispositionable violation
  into a blocking error run.
- Findings that cannot be read leave the verdict, the run status and the
  gate exactly as they would have been, and are retained as
  `EvaluatorFindingsUnreadableSchema` — a record of what was offered and
  why it failed, which is not a finding and not a pass.
- Identifier lengths and shape rules still refuse: a shortened path or
  key denotes something else, and an unknown key is incoherent.

Command producers and JSON-mode LLM evaluators carry findings in the
envelope; `readResultEnvelope` reads it in two steps so an envelope that
is wrong elsewhere stays an error run while bad findings do not.
Markdown-mode LLM evaluators may emit one optional
` ```orcaops-findings ` block whose content is
`{ "schema": "orcaops.evaluator_findings/v1", "findings": [...] }`;
`parseFindingsBlock` reads it, honouring CommonMark indentation so a
documented example cannot become a second block.

Every finding string crosses the same trust boundary as `body` and is
scrubbed with `scrubEvaluatorOutput` before it is handed over, after
which `boundEvaluatorFindings` truncates — that order, so a secret
straddling the cut cannot survive as a prefix.

The schemas and parser tests pin the grammar and full response table.

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
- A finding's `end_line` requires a `start_line` and may not precede it.
- A finding's `conclusion` requires at least one expectation location
  (plan step, acceptance criterion, requirement or decision).
- A finding's `title` is one line: CR, LF, NUL, U+000B, U+000C, U+0085,
  U+2028 and U+2029 are refused. A terminal escape is not — the scrubber
  removes it.
- A finding's file `path` is repository-relative POSIX with no `.`-only
  segment, no leading `~` and no control character; its `revision` is a
  full 40- or 64-character lowercase git object id, so `HEAD` and a
  branch name are refused.
- No id is blank or whitespace-only, including a handover's `run_id`.
- Finding `key`s are unique within one result, in the envelope, the
  markdown block and the storage handover alike.
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

The result envelope is the exception: `orcaops.evaluator_result/v2`
adds only the optional `findings` array, and the literal was bumped
anyway so the runner can tell a producer that has not been upgraded
from a producer that emitted nonsense. `inspectResultEnvelopeProtocol`
reads the literal before any strict parse and reports `current`,
`superseded`, `unknown` or `undeclared`; only the last is a malformed
envelope, and `unsupportedResultProtocolMessage` is the one wording both
engines use for the other two.

`EvaluatorResultEnvelopeSchema` stays exported, but NOT because retained
output is read with it: the envelope never reaches disk, since the runner
copies `body`, `raw` and `metrics` into `orcaops.evaluator_run/v1`. It
stays because the SDK, the packs, the CLI fixtures and `eval schema`
still emit and parse it until their slices land, and because negotiation
needs the literal to recognise. It can be removed once the release is
complete.

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
