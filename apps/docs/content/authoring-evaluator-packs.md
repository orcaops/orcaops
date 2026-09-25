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
  utilities. Pack code imports `EvaluatorContext`, `EvaluatorResultEnvelopeV2`,
  `EvaluatorVerdict`, and the like from here.
- `@orcaops/evaluator-sdk` — the runtime contract helpers
  (`readEvaluatorContext`, `writeResult`, `pass` / `violation` / `info`
  envelope constructors, the `finding` / `fileLocation` / `planStepLocation` /
  `acceptanceCriterionLocation` / `findingKey` finding builders,
  `runIfDispatched`, `safeExecute`) and the testing helpers (`makeContext`,
  `makePlanStep`, `runFixture`, `runLlmFixture`).

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
import type { EvaluatorContext, EvaluatorResultEnvelopeV2 } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelopeV2 {
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

## The result envelope

Every evaluator answers with one `orcaops.evaluator_result/v2` envelope: a
command engine prints it on stdout, and an LLM evaluator with
`output_format: json` returns it as its whole response. `pass()` /
`violation()` / `info()` build it. `orcaops eval schema result` prints the
field reference, with a filled-in envelope under `examples` and the rules the
shape cannot state in `$comment`.

| Field      | Required | Meaning                                                         |
| ---------- | -------- | --------------------------------------------------------------- |
| `schema`   | yes      | `orcaops.evaluator_result/v2`                                   |
| `verdict`  | yes      | `pass`, `violation`, or `info`                                  |
| `body`     | yes      | the prose a reader acts on                                      |
| `raw`      | no       | evaluator-defined, validated against the spec's `output_schema` |
| `metrics`  | no       | evaluator-defined numbers                                       |
| `findings` | no       | structured findings; keys unique within the array               |

### Findings

A finding is one factual statement your evaluator makes about the work it
inspected. `body` is that statement for a person; a finding is the same
statement in a shape Orcaops can retain, point at a file or a criterion, and
recognise again on a later run.

Findings are optional under every verdict. A `pass` may carry them, a
`violation` may carry none, and they never decide the gate — that stays the
evaluator's configured `severity`, the run status, and the verdict, exactly as
before.

| Field        | Required | Meaning                                            |
| ------------ | -------- | -------------------------------------------------- |
| `title`      | yes      | the statement, as one line                         |
| `detail`     | no       | elaboration, quotes, reasoning                     |
| `locations`  | no       | what it points at; at least one entry when present |
| `conclusion` | no       | `supported`, `contradicted`, or `unresolved`       |
| `key`        | no       | recurrence identity (see below)                    |

`locations` is a discriminated union, so a location is always exactly one kind
of pointer and can never be empty or incoherent:

| `kind`                 | Fields                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`                 | `path` (repository-relative, POSIX), optional `start_line` / `end_line`, optional `revision` — a full 40- or 64-character lowercase git object id |
| `plan-step`            | `step_id`                                                                                                                                         |
| `acceptance-criterion` | `criterion_id`                                                                                                                                    |
| `requirement`          | `revision_id`                                                                                                                                     |
| `decision`             | `revision_id`                                                                                                                                     |

Build them with `fileLocation()`, `planStepLocation()`, and
`acceptanceCriterionLocation()`. `fileLocation(path, { repoRoot })` normalizes
separators and strips the root you give it, which the schema will not do on
your behalf — it refuses a non-relative path rather than rewriting it, because
your original payload is retained beside the finding and a silently normalized
record would differ from what you emitted. There is no builder for
`requirement` or `decision`: no field of today's `EvaluatorContext` carries
such a revision id, so nothing you are given can populate one honestly.

A finding with no `locations` at all is valid. "The rationale does not explain
the trade-off" points at nothing in particular and is not worth less for it.
`revision` is the one identified input anywhere in the chain, so set it when
you actually read a committed object and leave it out otherwise — an
unconstrained value would collect `HEAD` and `working tree`, which identify
nothing.

`conclusion` is your conclusion about the expectation the finding names, in
this run, and nothing more. It is allowed **only** on a finding carrying at
least one expectation location — a plan step, an acceptance criterion, a
requirement, or a decision — because a path is where you looked, not what you
graded. `supported` is how you say an expectation is now met, and it matters:
no consumer may read that out of the absence of a finding, so a check that
verified something has to say so. The fourth conclusion the contract names,
_not assessed_, has no spelling here on purpose — it is the absence of a
finding, and giving it a value would let a producer assert it.

A finding deliberately carries nothing else, and each omission is load-bearing:
no `severity`, `confidence`, or score, because findings never decide the gate
and a self-rating is not knowledge — a producer-specific measure belongs in
`raw`, where your own `output_schema` validates it; no `kind` or `category`,
which would be an open vocabulary nobody validates when `evaluator_ref`
already categorizes the producer and `key` categorizes within it; no
`relation` on a location and no `suggested_fix`, because a typed relationship
and an assigned remediation are an actor's act, not a signal's; no `excerpt`,
which duplicates `detail` and adds a second path for repository content to
reach a retained record; no `basis` or `method`, because the runner already
establishes the engine, provider, model, and context it handed you, and a
self-declared basis would compete with an established one; and no `run_id` or
`artifact_id`, because the run event owns the run's identity and a second copy
is a second place for them to disagree.

### Identity and `key`

`key` is your answer to "is this the same thing I said last time?". A
recurrence is recognized as `(artifact_id, evaluator_ref, key)` — never across
artifacts.

Set `key` only when a later run of the same evaluator can name the same thing
the same way: a rule id, a path, a step id. Omit it when it cannot — a
judgement that happens to resemble last week's has no cross-run identity, and
nothing invents one for it. In particular nothing hashes your `title` into an
identity, because that would make a reworded statement a different finding and
two coincidentally identical statements one finding.

A key is at most 200 characters of letters, digits, `.`, `_`, `:`, `/`, and
`-`, starting with a letter or digit, with no `.` or `..` segment — so an
absolute path, a home-relative path, and a Windows path are all refused.
**A key built from a timestamp, a run id, or a counter is refused by nothing
and is still wrong**: it mints a fresh identity on every run, which is the
opposite of what `key` is for. `findingKey('rule', somePath)` joins segments
and returns `undefined` when they do not form a usable key, so a file name
with a space costs that one finding its identity instead of failing your run.

Two findings in one result may not claim the same key. There is no honest way
to pick between them.

### Bounds, and what never costs you the verdict

Two kinds of rule act on findings, and they act differently.

**Bounds truncate.** At most 100 findings, a `title` at 500 characters, a
`detail` at 4096, 10 locations per finding. Crossing one keeps the result,
shortens the content with a `…[truncated]` marker, and records a notice saying
how many findings were dropped, how many locations were dropped, and how many
titles and details were shortened — so a reader is never shown a shortened set
as if it were the whole one. They truncate rather than refuse on purpose: a
hundred-and-first finding that turned a dispositionable violation into an
error run would be a count deciding a gate, with no way out.

**Shape refuses**: an unknown key, a wrong type, an incoherent location, a
duplicate key, a `conclusion` with no expectation location. So do identifier
lengths — a shortened key, path, or id denotes something other than what you
named, so there is nothing worth keeping.

When findings are refused, **the verdict, the run status, and the gate stay
exactly what they would have been.** What was offered and could not be read is
retained as a record of its own, carrying the reason, so nobody mistakes
unreadable output for a check that found nothing. Too many findings, or ones
that cannot be read, cost you the findings and never the verdict.

`writeResult()` validates strictly before it writes, so a malformed finding
fails in your own process with a field path instead of arriving as findings
that could not be read.

### Scrubbing

Every string a finding carries — `title`, `detail`, every path, every id,
every key — crosses the same trust boundary as `body`: terminal formatting
stripped, recognized credential shapes redacted, before anything is retained.
Redaction runs before truncation, so a secret straddling a cut cannot survive
as an unmatched prefix. Report locations and labels; never depend on a
credential value surviving into the artifact.

A `title` may not contain any character that ends a line — CR, LF, NUL,
U+000B, U+000C, U+0085, U+2028, U+2029 — because it is rendered as one line by
every consumer, and a title that reshapes a digest row is incoherent whatever
it says. A terminal escape is not refused: it is unsafe rather than
incoherent, and the scrubber removes it.

### Upgrading from `orcaops.evaluator_result/v1`

The envelope literal changed, which makes this release breaking for producers.
Four combinations, and what each looks like in practice:

| Combination                           | What happens                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New pack, new Orcaops                 | Runs normally, with findings when your evaluator supplies them. A valid result may have none.                                                                      |
| **Old pack, new Orcaops**             | Every run is an `UNSUPPORTED_PROTOCOL` error naming the package, the version line, and that the pack must be rebuilt. No verdict is recorded.                      |
| New pack, old Orcaops                 | Unsupported. The old runner strict-parses the v1 literal and rejects a v2 envelope as `ENVELOPE_INVALID` — an error run under its existing rules. Upgrade Orcaops. |
| Retained history read by this release | Unchanged and readable. Nothing is migrated, reinterpreted, or rerun, and no finding identities are invented for output that carried none.                         |

::: warning Upgrade your pack before you upgrade Orcaops
An `UNSUPPORTED_PROTOCOL` run is an **error**, not a violation — and an error
from a `block`-severity evaluator cannot be acknowledged, dismissed, or
policy-excepted. Only a later successful run clears it, so a stale pack blocks
every capture until it is rebuilt. If you are already stuck, lower the
severity or disable the evaluator in `.orcaops/evaluators.yaml`, upgrade the
pack, then put it back.
:::

The upgrade itself:

1. Update `@orcaops/evaluator-sdk` to `0.2.x` and rebuild your pack. If you
   use `pass()` / `violation()` / `info()`, that is the whole change.
2. If you build the envelope JSON by hand, change
   `"schema": "orcaops.evaluator_result/v1"` to
   `"orcaops.evaluator_result/v2"`. That is one literal. No other field
   changed meaning, and none was removed.
3. Findings are optional. Add them where your check can name what it found;
   set `key` only when a later run can name the same thing the same way, and
   set `conclusion` only on a finding that names a plan step, an acceptance
   criterion, a requirement, or a decision.
4. LLM evaluators with `output_format: markdown` need no change at all.
   Emitting a findings block is opt-in and belongs in your prompt.

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

The things it checks are the ones an author can actually get wrong, and none of
them is fixed by a better model: whether the prompt **contains the data it
asks the model to reason over**, and whether the response shape the prompt
documents **parses to the verdict and the findings it means**.

````typescript
import { readFile } from 'node:fs/promises';
import { makeContext, runLlmFixture } from '@orcaops/evaluator-sdk';

const promptBody = await readFile('./prompts/my-checker.prompt.md', 'utf8');

const { prompt, contextBlock, verdict, findings } = runLlmFixture({
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
expect(findings).toEqual({ status: 'absent' });
````

Assert on `contextBlock` for what the model would have seen — including that
sections you did **not** declare are absent — and on `verdict` for what the
runner would record. A response with no verdict returns `null`, matching the
runner's `NO_VERDICT_LINE`.

`findings` is `absent`, `ok` with the findings, or `unreadable` with the
reason. Two cases are worth a test each: feed the **prompt body itself** as
the response and assert `absent`, which is the echo a model can produce at any
time, and feed a realistic response carrying a block and assert both the
findings and that the verdict did not move.

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

### Reporting findings from a markdown prompt

A markdown-mode evaluator may also ask for one `orcaops-findings` block,
placed **before** the sentinel so the sentinel stays last. Its content is JSON
carrying the same finding shapes as the envelope, so the protocol has one
negotiation rule and one set of schemas:

````markdown
```orcaops-findings
{
  "schema": "orcaops.evaluator_findings/v1",
  "findings": [{ "title": "…", "locations": [{ "kind": "plan-step", "step_id": "…" }] }]
}
```
````

JSON rather than a line grammar, and not by preference: a line grammar can
emit a line that is exactly `VIOLATION`, which the fence-blind fallback tier
would read as the verdict. Inside JSON every string is quoted and every
newline escaped, so no line of the block can be a bare verdict token.

The rules the parser applies:

- A block is a **top-level** backtick fence, indented at most three columns,
  whose info string is exactly `orcaops-findings`.
- **Exactly one block.** Two make the findings unreadable rather than picking
  one — an echoed example placed last would otherwise be adopted as real, and
  an honest answer split across two blocks would lose half in silence.
- No block at all means no findings. Absence is not malformation: every prompt
  that never asks for a block is such a response.
- A tilde fence, a stray backtick in the info string, an unclosed block,
  content past the block's own size cap, a repeated JSON key, an unsupported
  `schema` literal, or a finding that fails its shape makes the findings
  unreadable, with the reason. Each of those would otherwise read as "no block
  at all" and lose findings without a word. The block's cap refuses where a
  finding's own bounds truncate, because half a JSON document does not parse.

::: warning Show the example indented
A prompt that documents the block necessarily contains an example of it, and a
model may echo that example. **Indent your example by four spaces.** A fence
indented four or more columns is literal code in CommonMark and opens nothing,
so an echo of it produces no second block — the same reason a four-backtick
wrapper hides the example above. Do not rely on last-block-wins: unlike the
verdict sentinel, a second findings block is refused rather than preferred.
:::

Tell the model which location kinds it may use, and that it may only use ids
and paths the context block actually shows it. A criterion id it invented
points at nothing, and nothing downstream can tell that apart from one it
copied. `runLlmFixture` parses a response's findings alongside its verdict, so
both halves of that instruction are testable without a provider.

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
