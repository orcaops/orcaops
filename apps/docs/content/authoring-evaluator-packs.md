---
description: 'Build and test deterministic or LLM evaluator packs using the supported manifest, spec, SDK, and CLI contracts.'
---

# Authoring evaluator packs

This guide walks through writing a new evaluator pack for Orcaops. Packs are
the unit of distribution for evaluators — a manifest plus one or more
evaluator specs plus the runtime code that executes them. First-party packs
(`@orcaops/evaluator-pack`) and third-party packs follow the same shape.

::: tip Use the authoring skill
If you are working with an agent, ask it to use `orcaops-author-evaluator`. The
skill walks the same decisions in order and stops before granting durable trust.
This guide is the reference behind it: read it for the depth the skill leaves
out—subprocess lifecycle, consumer overrides, trust boundaries, and
distribution—or when you are authoring by hand. For the file shapes themselves,
prefer `orcaops eval schema <spec|manifest|result>` over copying the examples
below; it is generated, so it cannot drift.
:::

## Contract surface

A pack depends on exactly two Orcaops packages and nothing else from the
workspace:

- `@orcaops/evaluator-protocol` — schemas, types, and the glob/resolution
  utilities. Pack code imports `EvaluatorContext`, `EvaluatorResultEnvelope`,
  `EvaluatorVerdict`, and the like from here.
- `@orcaops/evaluator-sdk` — the runtime contract helpers
  (`readEvaluatorContext`, `writeResult`, `pass` / `violation` / `info`
  envelope constructors, `runIfDispatched`, `safeExecute`) and the testing
  helpers (`makeContext`, `makePlanStep`, `runFixture`, `runLlmFixture`).

Packs **MUST NOT** depend on `@orcaops/core`, `@orcaops/storage`, or
`@orcaops/cli`. Guardrail tests enforce this — a stray cross-package
import will fail CI.

External libraries (`simple-git`, `typescript`, etc.) are fine as long as
they don't pull in Orcaops internals transitively.

## Pack layout

```
my-pack/
  package.yaml           # pack manifest
  evaluators/
    my-checker.eval.yaml # one spec per evaluator
  runtime/
    my-checker.ts        # one runtime entry per command-engine evaluator
  prompts/               # optional, for engine.kind: llm evaluators
    my-checker.prompt.md
  fixtures/              # optional, for fixture testing
    my-checker/
      pass.context.json
      violation.context.json
```

### Minimal manifest

`package.yaml`:

```yaml
schema: orcaops.evaluator_package/v1
id: my-pack
name: My Pack
version: 0.1.0
description: One-line description of what this pack provides.
evaluator_dir: ./evaluators
```

### Minimal spec

`evaluators/plan-has-budget.eval.yaml`:

```yaml
schema: orcaops.evaluator/v1
id: plan-has-budget
phase: post-plan
severity: warn
description: >-
  Flag plans that don't mention a budget — projects with unstated cost
  expectations tend to grow scope.
engine:
  kind: command
  command:
    - node
    - ./runtime/plan-has-budget.js
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
  tokens: [budget, cost, spend, dollars]
```

`params_schema` is enforced at discovery time via ajv. Setting
`additionalProperties: false` catches typos in user overrides before
they reach your runtime.

### Minimal runtime

`runtime/plan-has-budget.ts`:

```typescript
#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  const tokens = ctx.params.tokens as string[];
  const haystack = ctx.plan.plan_steps.map((s) => s.text.toLowerCase()).join(' ');
  const hit = tokens.find((t) => haystack.includes(t.toLowerCase()));
  if (hit) {
    return pass(`PASS\n\nFound \`${hit}\` in plan_steps.`);
  }
  return violation(`VIOLATION\n\nNone of [${tokens.join(', ')}] mentioned in any plan_step.`);
}

runIfDispatched(check);
```

The contract:

- Use `runIfDispatched(check)` for the command entry point. It reads and
  validates `ORCAOPS_CONTEXT_PATH` only when the runner dispatches the module,
  then writes the returned envelope to stdout.
- Return one envelope from `pass(body, extras?)` / `violation(body, extras?)` /
  `info(body, extras?)`.
- Unexpected errors are diagnostics, not evaluator-authored findings:
  `runIfDispatched` reports them on stderr and exits nonzero, and the runner
  records `run_status: error` with no verdict.

`check()` is exported so fixture tests can call it without spawning a
subprocess.

## Testing an evaluator

There are two loops. **Start with the SDK loop** — it is an ordinary vitest
run with no CLI, no repository, and no provider, and it is what the
first-party packs use. Reach for the CLI loop afterwards, to confirm the
whole path works end to end.

### The SDK loop (start here)

Every helper below comes from `@orcaops/evaluator-sdk`.

#### Building a context

`EvaluatorContext` is a strict schema with eighteen required keys, three of
them nullable and required to be _present_ as `null`. Do not hand-roll one:

```typescript
import { makeContext, makePlanStep } from '@orcaops/evaluator-sdk';

const ctx = makeContext({
  params: { tokens: ['budget'] },
  plan: {
    ...makeContext().plan,
    plan_steps: [makePlanStep(1, 'allocate budget for the rollout')],
  },
});
```

`makeContext` parses its result, so an override that breaks the contract
fails on the line that wrote it rather than inside the code under test.

#### Pure-function tests

If your runtime exports `check()`, call it directly:

```typescript
import { describe, expect, it } from 'vitest';
import { makeContext, makePlanStep } from '@orcaops/evaluator-sdk';
import { check } from './plan-has-budget.js';

describe('plan-has-budget check()', () => {
  it('passes when budget is mentioned', () => {
    const ctx = makeContext({
      params: { tokens: ['budget'] },
      plan: {
        ...makeContext().plan,
        plan_steps: [makePlanStep(1, 'allocate budget for the rollout')],
      },
    });
    expect(check(ctx).verdict).toBe('pass');
  });
});
```

`runIfDispatched` is a no-op when the module is imported outside an evaluator
dispatch, so pure-function tests do not write output or change the process exit
status.

#### Subprocess tests — command engines

`runFixture` spawns the actual command through the same primitive production
dispatch uses, so a runtime behaves identically in fixtures and in production:

```typescript
import { makeContext, runFixture } from '@orcaops/evaluator-sdk';

const result = await runFixture({
  command: ['node', './dist/runtime/plan-has-budget.js'],
  cwd: import.meta.dirname,
  context: makeContext({ params: { tokens: ['budget'] } }),
});
expect(result.envelope.verdict).toBe('pass');
```

#### Prompt and verdict tests — LLM engines

`runLlmFixture` assembles the prompt exactly as the runner would and parses a
response you supply. It calls no provider, so it is deterministic and free.

The two things it checks are the two an author can actually get wrong, and
neither is fixed by a better model: whether the prompt **contains the data it
asks the model to reason over**, and whether the response shape the prompt
documents **parses to the verdict it means**.

````typescript
import { readFile } from 'node:fs/promises';
import { makeContext, runLlmFixture } from '@orcaops/evaluator-sdk';

const promptBody = await readFile('./prompts/my-checker.prompt.md', 'utf8');

const { prompt, contextBlock, verdict } = runLlmFixture({
  context: makeContext({
    source_plan: {
      /* … */
    },
  }),
  promptBody,
  // Must match engine.additional_context_sections in your spec.
  additionalContextSections: ['source-plan'],
  response: '```orcaops-verdict\nVIOLATION\n```',
});

expect(contextBlock).toContain('Source plan (pinned, immutable):');
expect(verdict).toBe('violation');
````

Assert on `contextBlock` for what the model would have seen — including that
sections you did **not** declare are absent — and on `verdict` for what the
runner would record. A response with no verdict returns `null`, matching the
runner's `NO_VERDICT_LINE`.

### The CLI loop (end-to-end)

`orcaops eval test` runs one evaluator against a fixture file describing a
synthetic artifact thread. It exercises discovery, config resolution, trust,
and context building — everything the SDK loop deliberately skips.

Get a valid fixture to start from:

```sh
orcaops eval test --print-example-fixture > fixture.json
orcaops eval test --ref my-pack/plan-has-budget --fixture fixture.json
```

`--print-example-fixture` needs no configured repository, and the fixture it
emits parses and runs as-is.

**The fixture file is not an `EvaluatorContext`.** It is a _storage input_
shape — `plan`, optional `checkpoints`, optional `summary` — that the CLI
materializes into a disposable store and turns into a context. `runFixture`
takes the context; `eval test` takes the fixture file. They are different
shapes with different keys.

Fixture invariants worth knowing before you fight one:

- Each checkpoint declares `status: 'open'` or `status: 'closed'`. Closed
  checkpoints carry `summary`, `files_changed`, `done_criteria`, and the rest;
  open ones carry only the fields present at open time. **A `checkpoint-open`
  evaluator needs an open checkpoint** — with only closed ones it sees no
  `current_checkpoint` and can reach nothing but its no-open-checkpoint pass.
- `declared_step_ids` must name steps in the plan, and concurrent open
  checkpoints must declare disjoint scopes.
- `plan_revision_id: null` opts out of the staleness check.
- A fixture cannot pair a `summary` with an open checkpoint — a summary
  finalizes the artifact.
- `fires_at` chooses the phase (defaulting to the evaluator's own), and
  `checkpoint_n` names which checkpoint the run is about.

### Reading results back in your agent

An evaluator's `body` and `raw` flow back to whatever invoked the CLI, in the
`evaluator_results` array of the capture response. An agent that just ran
`capture checkpoint close` can read a violation's `body` and react to it in
the same turn — so `body` is worth writing for a reader who has to act on it,
not just for a log.

## LLM-engine evaluators

An `engine.kind: llm` evaluator has no runtime file. It has a prompt, and the
runner prepends a `## Context` block before it.

### Declaring the context you need

```yaml
engine:
  kind: llm
  prompt_file: prompts/my-checker.prompt.md
  output_format: markdown
  additional_context_sections:
    - source-plan
```

`additional_context_sections` is **required and has no default.** Every LLM
evaluator receives a baseline block regardless — plan task, branch, phase,
touched scope, non-goals, plan steps, checkpoint summaries, changed files,
summary outcome — gated only on whether that data exists. This field selects
what is sent _in addition_:

| Section                 | What it adds                                               |
| ----------------------- | ---------------------------------------------------------- |
| `acceptance-criteria`   | Each step's rubric, with criterion ids                     |
| `delivered-checkpoints` | Per-closed-checkpoint completed steps + claimed evidence   |
| `diff-boundary`         | base/head SHA, changed files, worktree-inspection guidance |
| `source-plan`           | The full pinned source-plan document                       |

::: warning Provider context
`[]` does not disable egress. It means “the baseline is enough.” Declare it
explicitly when that is true.

Every declared section is data leaving the repository. It goes to the resolved
effective provider: `engine.provider` from your spec or the consumer's
`.orcaops/evaluators.yaml` override, and otherwise the repository's global
`llm.tool` default—which may be an implicitly selected provider neither you nor
the consumer named. Declare a section because the prompt reads it, not in case
it turns out useful.
:::

The field is required rather than defaulted because both defaults fail
quietly. Defaulting to everything would widen egress for every evaluator
without changing any pack's fingerprint, so no trust re-prompt would fire.
Defaulting to nothing would silently starve evaluators of data they ask the
model to reason over. There is deliberately **no consumer override** for it —
what leaves the repository is the pack author's declaration, like
`tool_policy`.

### Reporting a verdict

End the response with a fenced `orcaops-verdict` block containing exactly one
of `PASS`, `VIOLATION`, or `INFO`:

````markdown
Two acceptance criteria are under-delivered.

```orcaops-verdict
VIOLATION
```
````

Your prompt should ask for prose first and the sentinel last. **When several
sentinels appear the last one wins** — a prompt that documents the sentinel
necessarily contains an example of it, and a model may echo that example
before committing to its own answer. The parser sees only the response body
and cannot tell an echo from an intent.

If a response carries no sentinel at all, the runner falls back to the last
standalone `PASS` / `VIOLATION` / `INFO` line. That fallback is fence-blind:
a bare verdict token inside an unrelated example block will be read as real.
So **never write a bare verdict token in prose** — in your prompt or in the
shape you ask the model to produce. Emitting a sentinel is what makes a
response unambiguous.

A response with neither is recorded as `run_status: error` with
`NO_VERDICT_LINE`, not as a verdict.

## Subprocess lifecycle

Both the runner's command engine and `runFixture` execute through one
shared primitive, so a runtime's spawn, timeout, and termination behave the
same in fixtures and in production.

**The environment is the exception.** `runFixture` inherits your ambient
`process.env`; production builds the subprocess env from an allowlist that
starts empty — `engine.env.inherit` names what survives, `engine.env.set`
adds to it, and Orcaops injects its own `ORCAOPS_*` vars. A command engine
that omits `env.inherit: [PATH]` therefore passes every fixture test and
fails in production with `spawn node ENOENT`. Reach for `orcaops eval test`
to catch it; the SDK loop structurally cannot.

What the shared primitive does guarantee:

- **The timeout runs from spawn.** `engine.timeout_ms` (or `runFixture`'s
  `timeoutMs`, default 30s) bounds total wall-clock, not idle time.
- **Termination escalates.** On timeout, cancellation, or output overflow
  the runtime gets `SIGTERM`; if it has not exited one second later it gets
  `SIGKILL`. The grace is measured from the SIGTERM, so a cancelled
  long-timeout evaluator still dies promptly. Trapping `SIGTERM` only buys
  your runtime that grace period.
- **Process-group descendants die when Orcaops terminates you.** On POSIX the
  runtime leads its own process group and a timeout, cancellation, or overflow
  signals that whole group — including after the group leader exits, since the
  SIGKILL escalation outlives it. A child in the group gets the same
  SIGTERM-then-grace treatment, so it can clean up within the grace. A process
  that deliberately detaches into another session or process group is outside
  this portable guarantee and can survive, as can a daemon left behind when
  the runtime exits on its own.
- **Output is byte-capped per stream.** `engine.max_output_bytes` applies to
  stdout and stderr independently; crossing it terminates the runtime and
  reports `OUTPUT_TOO_LARGE`. It defaults to 1 MiB and cannot exceed 8 MiB.
  Write one envelope to stdout and keep diagnostics on stderr small.
- **Persisted evaluator output is secret-scrubbed.** Recognized credential
  shapes in `body`, provider-reported model names, string-valued `raw` fields,
  attacker-controlled object keys, and error messages are replaced after
  parsing and output-schema validation but before the run is recorded. A
  private-key header whose matching terminator is missing, mismatched, or not
  a complete line consumes the rest of its string because no safe closing
  boundary can be established. Evaluators must report locations or labels,
  never depend on a credential value surviving in the artifact.
- **A killed runtime is reported as killed**, not as a missing envelope:
  timeout, cancellation, and overflow each surface distinctly.

**Windows is best-effort.** There is no process-group kill, so only the
direct child is signalled and descendants may survive a timeout or
cancellation. Job-object based containment is not implemented and its
verification is explicitly out of scope; treat Windows as unsupported for
runtimes that spawn their own children.

## Consumer engine overrides

Pack consumers may override an LLM evaluator's `provider`, `model`, and
`timeout_ms` in `.orcaops/evaluators.yaml`. Those operational choices take
precedence over the values in the evaluator spec so a pack remains usable with
the consumer's installed CLI and latency budget. `provider: null` clears a pack
pin; `model: null` requests the selected provider's default model.

The prompt, output format and schema, tool policy, effort, and cost ceiling stay
author-owned. Consumers must fork the pack to change those calibration,
capability, or spending controls. Avoid relying on a provider-specific model
name unless the spec also pins that provider; Orcaops intentionally does not
maintain a model-name catalog or normalize aliases across providers.

## Trust boundaries

Third-party evaluator packs are trusted executable code. Command evaluators and
processes they launch run with the invoking user's permissions; Orcaops does not
provide an OS sandbox or workspace confinement. The consent fingerprint covers
the pack manifest, evaluator specs, referenced description and prompt files,
pack-contained regular files named by `engine.command[]`, and files selected by
`fingerprint.include`. It does not cover PATH/system interpreters, imported
dependencies that are not separately declared, later command arguments
resolved from the repository working directory, undeclared data files, or
other runtime state.

Pack consumers (via `orcaops eval add-pack`) must consent to each capability
class their pack contains:

- **`command_evaluators_present`** — pack contains evaluators that execute
  local code with the invoking user's permissions. The runner spawns them with
  the declared env policy; users who don't trust the pack should not enable it.
- **`llm_evaluators_present`** — pack contains evaluators that dispatch to
  the local LLM CLI. Each invocation sends captured context through the
  user's authenticated provider and consumes credits.
- **`file_reading_llm_evaluator_present`** — in addition to LLM dispatch, the
  evaluator can read files through provider tools. Claude uses a command
  allowlist plus a secret-path denylist; that policy is not an OS sandbox and
  does not confine the process or allowed Git commands to the repository.
  Prompt, description, spec, and evaluator-directory paths are resolved and
  symlink-checked within the pack before Orcaops reads them.

If your pack does anything beyond reading evaluator context and writing
an envelope — touches the filesystem, runs git commands, talks to a
network service — document it in the spec's `description` so users
considering the install see the surface clearly.

### Granting trust in CI and fresh clones

A grant is user-local, and bound to the pack's fingerprint rather than to where
the repository sits — so a second clone of the same pack bytes on the same
machine reuses it without prompting again. Only `--dev` binds to a path. Each
machine grants once:

```sh
orcaops eval trust <pack-id> --yes
```

For a workspace pack whose files churn as you edit them, bind the grant to the
resolved path instead of a fingerprint:

```sh
orcaops eval trust <pack-id> --dev --yes
```

`--dev` only applies to a `kind: path` source. Editing a pack's specs, prompts,
or command files changes its fingerprint and invalidates a non-`--dev` grant —
which is the point: the bytes you consented to are the bytes that run.

## Distribution

Third-party packs publish as npm packages. The pack root the resolver
expects must contain the manifest at the top level (or a `dist/packs/<id>/`
subtree for the bundled-with-CLI pattern). The package's `exports` map
should advertise `./packs/<id>/*` paths so external resolvers can find
the contents.

Users install with `pnpm add -D @your-org/your-pack`, then register:

```sh
orcaops eval add-pack @your-org/your-pack <pack-id>
```

The pack is resolved from the user's project dependencies; `kind: package`
gets recorded in `.orcaops/evaluators.yaml`. The pack stays read-only at
its installed location; `orcaops eval fork-pack` is available if a user
wants to vendorize and edit.
