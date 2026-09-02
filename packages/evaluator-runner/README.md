# @orcaops/evaluator-runner

The runtime engine for orcaops evaluators. Owns discovery
(load `.orcaops/evaluators.yaml`, walk packs, parse specs, apply
overrides, validate params via ajv), the **command** + **llm**
engines (subprocess execution, structured-output parsing, error
envelope mapping), bounded parallel dispatch, picomatch-driven
filtering, and soft-block fingerprinting.

Depends on `@orcaops/evaluator-protocol` (schemas + ResolvedEvaluator
shape) and `@orcaops/llm` (LLMClient interface). Does NOT depend on
`@orcaops/storage` — the runner is upstream of the persistence
layer. The CLI lifecycle (`@orcaops/cli`) wires this runner into
capture commands; the runner itself knows nothing about events,
projections, or SQLite.

This README is the API reference.

## Surfaces

| Surface                              | Export                                                        |
| ------------------------------------ | ------------------------------------------------------------- |
| Discovery + resolution               | `discoverEvaluators`                                          |
| Load a single config / pack / spec   | `loadEvaluatorConfig`, `loadPackage`, `loadSpecs`             |
| Build an ajv-backed params validator | `createParamsValidator`                                       |
| Command engine                       | `runCommandEngine`                                            |
| LLM engine                           | `runLlmEngine`                                                |
| Subprocess helper                    | `runSubprocess`, `buildSubprocessEnv`                         |
| Filter gates                         | `shouldSkipEvaluator`, `makeSkippedRun`                       |
| Bounded parallel dispatch            | `dispatchEvaluators`, `dispatchOne`                           |
| Soft-block fingerprint               | `computeEvaluatorFingerprint`, `combineEvaluatorFingerprints` |
| Canonical JSON helper                | `canonicalJson`                                               |

## Discovery pipeline

```
.orcaops/evaluators.yaml
        │
        ▼
loadEvaluatorConfig (ENOENT → empty result)
        │
        ▼
for each entry in `packages`:
  loadPackage(<path>/package.yaml)
  loadSpecs(<pack>/<evaluator_dir>/*.eval.yaml)
        │
        ▼
for each spec:
  resolveEvaluator(spec, pack manifest, override?, validate_params: ajv)
        │
        ▼
assertUniqueRefs(resolved[*].ref)
        │
        ▼
ResolvedEvaluator[]
```

Capture mode (no `onError`) throws on first error.
Inspection mode (`onError` callback provided) collects errors and
keeps loading so `eval list` / doctor can surface every issue at
once.

## Command engine

Spawns a subprocess (argv array, never a shell string), writes the
context JSON to BOTH stdin AND a temp file exposed via
`$ORCAOPS_CONTEXT_PATH`, and parses stdout as the
`orcaops.evaluator_result/v1` envelope. Every failure mode maps to
a structured EvaluatorRunPayload error:

| Code                 | Trigger                                                     |
| -------------------- | ----------------------------------------------------------- |
| `TIMEOUT`            | exceeded `engine.timeout_ms` (SIGTERM → 1s grace → SIGKILL) |
| `EXIT_CODE`          | non-zero exit                                               |
| `JSON_PARSE`         | stdout is not JSON                                          |
| `ENVELOPE_INVALID`   | JSON does not match `EvaluatorResultEnvelopeSchema`         |
| `RAW_SCHEMA_INVALID` | `engine.output_schema` validation failed on `raw`           |
| `OUTPUT_TOO_LARGE`   | stdout or stderr exceeded `engine.max_output_bytes`         |
| `CANCELED`           | parent aborted via `AbortSignal`                            |
| `SPAWN_ERROR`        | ENOENT on the executable, etc.                              |

### Subprocess env contract

| Var                                           | Purpose                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ORCAOPS_RUN_ID`                              | UUID for this run                                                                      |
| `ORCAOPS_PHASE`                               | `post-plan` / `post-plan-revision` / `checkpoint-open` / `checkpoint-close` / `pre-pr` |
| `ORCAOPS_ARTIFACT_ID`                         | artifact UUIDv7                                                                        |
| `ORCAOPS_CHECKPOINT_N`                        | checkpoint number (when applicable)                                                    |
| `ORCAOPS_REPO_ROOT`                           | absolute repo root                                                                     |
| `ORCAOPS_PACKAGE_ROOT`                        | absolute pack root                                                                     |
| `ORCAOPS_EVALUATOR_REF`                       | resolved ref like `core/api-stability`                                                 |
| `ORCAOPS_CONTEXT_PATH` / `ORCAOPS_INPUT_PATH` | temp file with the context JSON                                                        |

`env.inherit` is an allowlist of parent env vars that pass through;
`env.set` provides explicit values. The orcaops contract vars
override `env.set` so packs can't accidentally shadow them.

## LLM engine

Reads `prompt_file` from disk, builds the deterministic
`## Context` block (sections omitted when empty — no
"Changed files: (none)" noise), composes
`<context>\n\n## Task\n\n<prompt body>`, calls
`LLMClient.evaluate` via Effection's `run()` boundary, and parses
the response per `output_format`:

**markdown** (default) — reads the LAST ` ```orcaops-verdict `
sentinel block, falling back to the LAST standalone
`PASS` / `VIOLATION` / `INFO` line when no sentinel is present.
Returns `NO_VERDICT_LINE` when neither tier finds a verdict.

The context block's baseline always renders; the spec's
`engine.additional_context_sections` selects the heavier opt-in
sections (`acceptance-criteria`, `delivered-checkpoints`,
`diff-boundary`, `source-plan`). It is required with no default, and
there is deliberately no consumer override — what leaves the
repository for the provider is the pack author's declaration.

**json** — parses `result.body` as JSON. Validates the envelope's
`raw` field against `engine.output_schema` via the injected
`validateRaw` callback. Retries once with a `REMINDER` nudge on
parse / schema failure (`json_mode_retries` default 1).

Structured `LLMClient` errors (TIMEOUT / BUDGET / PARSE / etc.)
surface as `LLM_ERROR`.

## Bounded parallel dispatch

`dispatchEvaluators` runs up to `maxConcurrent` evaluators
concurrently (default 4). Slots advance independently through the
input queue — a real parallel pool, not a single-slot queue
dressed up as one. Filter-skipped evaluators (paths / scopes /
when_llm gates) return `run_status: 'skipped'` without engine
dispatch.

`runs[]` is returned in the SAME order as the input
`evaluators[]`, regardless of completion order.

Cancellation: an `AbortSignal` threads through to every in-flight
subprocess (SIGTERM → SIGKILL) and is forwarded to configured LLM
providers. Provider-specific shutdown timing still determines when an
in-flight model call releases its resources.

## Fingerprinting

`computeEvaluatorFingerprint(resolved)` computes a sha256 over:

1. `evaluator_ref`
2. sha256 of the spec file's content
3. sha256 of every file matched by `fingerprint.include` globs
4. canonical JSON of resolved `params`
5. canonical JSON of resolved `severity`

Inputs are sorted before hashing so the order of glob-matched
files doesn't affect the fingerprint. Glob expansion happens
against the pack root with `./` and leading `/` prefixes
normalized away.

`combineEvaluatorFingerprints(resolveds)` returns a single sha256
over the sorted `<ref>=<fp>` joins — the soft-block replay key
for the checkpoint-open gate.

Zero-match globs surface in `FingerprintResult.empty_patterns`
for doctor to warn on, but are NOT an error.

## Scope

The runner package owns:

- All discovery + resolution logic
- Both engines (command, llm)
- Filter gates + the bounded parallel pool
- Soft-block fingerprint computation

The runner package does NOT own:

- Event log writes / projection updates (`@orcaops/storage`)
- LLM provider construction (`@orcaops/llm`'s `buildLLMClient` is called by callers)
- CLI lifecycle wiring (`@orcaops/cli`)
- The actual pack contents (`@orcaops/evaluator-pack`)
- Doctor / digest rendering (`@orcaops/core`)
