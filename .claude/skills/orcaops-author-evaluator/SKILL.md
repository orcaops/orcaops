---
name: "Orcaops: author an evaluator"
description: "Author a new orcaops evaluator — command-engine (deterministic) or LLM-engine — for this repo or a distributable pack: \"write an evaluator that blocks X\", \"add a check for Y at checkpoint close\", \"create an evaluator pack\". Walks the spec, the engine choice, phase and severity semantics, the context an LLM evaluator declares, the verdict sentinel, and the SDK + CLI test loop. Stops at dev registration — it never grants durable trust and never enables an evaluator. Not for running or debugging evaluators that already exist."
disable-model-invocation: true
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "1dbce7fa6626"
tags: ["orcaops", "authoring"]
---

# When to use

Authoring a NEW evaluator — a check that runs at a capture lifecycle
phase and returns pass / violation / info. Both engine kinds live here:

- **command engine** — you write a program; it reads a context and
  prints a result envelope. Deterministic, free, fast.
- **LLM engine** — you write a prompt; a provider answers it. Costs a
  call per run and can be wrong in ways a test cannot pin.

**Route to the command engine unless the judgment is irreducibly
linguistic.** "Does the plan mention tests" is string work. "Does this
summary honestly describe what shipped" is not. If you can express the
check as code without embarrassment, the LLM engine is the wrong tool:
it is slower, costs money, sends repository content to a provider, and
turns a deterministic test into a flaky one.

Not for: running, debugging, or enabling evaluators that already exist
(`orcaops eval list`, `orcaops eval run`, `orcaops eval show`), and not
for tuning a pack someone else ships.

# 1. Check the packages resolve

A pack depends on exactly two orcaops packages:

```sh
node -e "import('@orcaops/evaluator-protocol').then(()=>console.log('protocol ok'))"
node -e "import('@orcaops/evaluator-sdk').then(()=>console.log('sdk ok'))"
```

If either fails to resolve, install them before writing anything —
`pnpm add -D @orcaops/evaluator-protocol @orcaops/evaluator-sdk` (or the
equivalent for the project's package manager). Do this FIRST. Every
shape below is reachable from those two packages, and a module-resolution
error surfaced later reads like a typo in your import rather than a
missing dependency.

Packs must NOT import `@orcaops/core`, `@orcaops/storage`, or the CLI.

# 2. Pick the phase — what data exists when

`phase` decides what your evaluator can see, so pick it from the data
you need, not from when it feels natural to complain.

| Phase | Fires when | What is there |
| --- | --- | --- |
| `post-plan` | a plan is captured, AND again on every revision | plan only — no checkpoints, no diff |
| `post-plan-revision` | a plan is revised | the same, plus `prior_plan` |
| `checkpoint-open` | before an open is appended | the plan and the checkpoint being opened |
| `checkpoint-close` | a checkpoint is finalized | the plan, closed checkpoints, the diff |
| `pre-pr` | the pre-PR pass | everything except the summary |

A revision fires BOTH plan phases: `post-plan` re-validates the new plan
against every plan-aware evaluator, and `post-plan-revision` runs the
checks that need to see what CHANGED. Pick the second only if you are
comparing revisions — scope that widened, a non-goal that vanished, a
rationale that says nothing. Otherwise `post-plan` covers both moments
and you write one evaluator instead of two.

`prior_plan` is the only field that phase adds, and it is null more often
than authors expect: null at every other phase, and null at
`post-plan-revision` itself whenever `revision_n` is 0. Branch on it;
never assume it.

To test one, **omit `fires_at` from the fixture** — `eval test` falls
back to the evaluator's own phase. Setting it explicitly is the one thing
that fails: the fixture field accepts only the other four names.

A fixture plan is revision 0, so `prior_plan` is null in that run. That
exercises your null branch, not your comparison. For the logic that
actually reads two plans, build both with `makeContext()` in the SDK
loop and pass a non-null `prior_plan`.

Two constraints the parser enforces:

- **`phase: checkpoint-open` requires `engine.kind: command`.** Open sits
  on the agent's hot path and cannot afford a provider round-trip. An
  LLM evaluator at that phase is rejected at discovery.
- **A `checkpoint-open` fixture must name an open checkpoint.** Set
  `checkpoint_n` to one whose status is open; orcaops rejects a
  reference that is absent, unresolved, closed, or ambiguous, so the
  evaluator is guaranteed a real `current_checkpoint` rather than
  reaching a vacuous no-checkpoint branch.

A summary cannot coexist with an open checkpoint — a summary finalizes
the artifact — so no fixture can carry both.

## `filters` decide whether you run at all

Three keys, and the first one has a trap:

- `paths` — globs matched against `changed_files`. **Declaring `paths`
  on a plan-phase evaluator silences it permanently.** `changed_files`
  is empty at `post-plan`, `post-plan-revision`, and `checkpoint-open`,
  and non-empty `paths` with no changed files is a SKIP, not a pass.
- `scopes` — skips when your declared scopes are disjoint from the plan's
  `touched_scope`.
- `when_llm` — `required` skips when no provider is configured, `absent`
  skips when one IS, and the default `optional` never skips.

Where `changed_files` comes from is worth knowing before you filter on
it: at `checkpoint-close` it is that checkpoint's **declared**
`files_changed`, and at `pre-pr` the union of every closed checkpoint's.
It is the agent's claim about what it touched, not a diff orcaops
computed — so a path filter trusts that claim.

# 3. Pick the severity — and mean it

- `info` — recorded, never surfaces as a problem.
- `warn` — surfaces in the response; the capture still succeeds.
- `block` — **the human's capture call fails.** Their work stops until
  they rewrite, acknowledge, or dismiss.

Choose `block` deliberately. A blocking evaluator that fires on
judgment calls trains people to dismiss it, which costs you the ones
that mattered.

Two parser rules follow from severity, and they cut both ways:

- **`severity: block` requires `on_block_message`** — the remediation the
  human reads at the moment they are stopped. There is no default, on
  purpose: a block with no way out is the failure mode.
- **Every other severity FORBIDS `on_block_message`.** A block-only field
  on a `warn` evaluator is almost always a copy-paste bug, so it is
  rejected rather than ignored.

# 4. LLM engines: declare the context you need

`additional_context_sections` is **required and has no default**. Four
names, and nothing else parses:

| Section | What it adds |
| --- | --- |
| `acceptance-criteria` | each step's rubric, with criterion ids |
| `delivered-checkpoints` | per-closed-checkpoint completed steps and claimed evidence |
| `diff-boundary` | base and head SHA, changed files, worktree-inspection guidance |
| `source-plan` | the full pinned source-plan document |

**Declaring a section widens what leaves the repository.** Every LLM
evaluator already sends a baseline block — task, branch, phase,
`touched_scope`, `non_goals`, `plan_steps`, checkpoint summaries,
`files_changed`, summary outcome — to the resolved provider. This field
selects what goes ON TOP of that. Declare a section because the prompt
reads it, not because it might be useful.

`[]` is a real answer and does not disable egress; it means the
baseline is enough. Write it explicitly when that is true.

# 5. LLM engines: the verdict sentinel

End the response with a fenced `orcaops-verdict` block holding exactly
one of `PASS`, `VIOLATION`, `INFO`. Ask the prompt for prose first and
the sentinel last.

**When several sentinels appear, the last one wins.** This is not a
detail you can ignore: a prompt that documents the sentinel necessarily
CONTAINS an example of it, and a model may echo that example before
committing to its own answer. The parser sees only the response body and
cannot tell an echo from an intent. Last-wins is what makes the model's
final word the one recorded.

If no sentinel appears at all, the runner falls back to the last
standalone verdict token — and that fallback is fence-blind, so a bare
`VIOLATION` inside an unrelated example block is read as real. **Never
write a bare verdict token in prose**, in the prompt or in the shape you
ask the model to produce. A response with neither is an error, not a
verdict.

# 6. LLM engines: tool_policy

`tool_policy` defaults to deny-all. An evaluator that must READ THE
WORKTREE needs `mode: command-filtered` — the trap is that
`diff-boundary` gives the model the boundary to read within, not the
ability to read. Declaring the section and forgetting the policy yields
an evaluator that reasons about a diff it cannot open.

The shipped `step-coverage` evaluator is the reference shape: it grades
delivered work against each step's rubric, so it declares all three of
`acceptance-criteria`, `delivered-checkpoints`, `diff-boundary` AND a
`command-filtered` policy.

`command-filtered` is command filtering, not an OS sandbox. It also
trips an extra consent class at install, so consumers see that the
evaluator reads files.

# 7. The rules the emitted schema does not carry

`orcaops eval schema spec` gives you the structural shape. It is a
projection, and it is generated: orcaops states these five rules as
refinement code, which the generator reads as an opaque function and
drops. All five are therefore ABSENT from the file and enforced only by
orcaops parsing. A spec that validates clean against the projection can
still be rejected.

The gap is in the generator, not the format — `if` / `then`, `oneOf`,
and `not` express every one of these fine, which matters directly when
you hand-write `params_schema`: that IS JSON Schema, ajv validates it at
discovery, and you can put cross-field constraints in it.

Three are above (`checkpoint-open` needs the command engine;
`severity: block` requires `on_block_message`; every other severity
forbids it). The remaining two:

- **Exactly one of `description` or `description_file`.** Neither is
  rejected, and both is rejected. Inline for a sentence; a file when the
  description is long enough that consumers should read it before
  granting trust.
- **`output_format: json` requires `output_schema`.** It is passed to the
  provider's structured-output mechanism and validates the envelope's
  `raw` field — never the envelope itself, which is fixed.

## And one rule that is not a refinement at all

`timeout_ms` is **optional on the engine and required by the pack
resolver.** It has to be set either there or as `defaults.timeout_ms` in
`package.yaml`; with neither, the spec parses, the projection accepts it,
and discovery then refuses to load the evaluator.

Keep it separate in your head from the five above. Those are single-file
rules rejected at PARSE. This one spans the spec and the manifest and is
rejected at RESOLUTION — a different layer, a different error, and the
first thing you hit if you write a spec from the field reference alone.
Start from `--example`, which sets it.

Run `orcaops eval test` before you believe a spec is valid. It is
authoritative; the projection is a map, and neither the projection nor
the parser sees everything the resolver enforces.

# 8. The test loop, in this order

**First — the SDK loop.** An ordinary vitest run: no CLI, no repository,
no provider. Build the context with `makeContext()` and
`makePlanStep()` — the context is a strict schema with nullable keys that
must be PRESENT as null, and `makeContext()` parses its result, so a bad
override throws on the line that wrote it instead of inside the code
under test. Never hand-roll one.

- Command engine: export a `check` function and call it directly, then
  spawn it once through `runFixture()` — the same spawn primitive
  production dispatch uses.

  **It does not reproduce the production environment.** `runFixture()`
  inherits your ambient env; production builds the subprocess env from an
  ALLOWLIST that starts EMPTY. So an engine missing
  `env.inherit: [PATH]` passes every SDK test and then dies with
  `spawn node ENOENT` for real. Only the CLI loop below catches it.
- LLM engine: `runLlmFixture()` assembles the prompt exactly as the
  runner would and parses a response you supply, calling no provider.
  Assert on the context block for what the model would have seen —
  **including that sections you did not declare are absent** — and on the
  verdict for what the runner would record.

**Second — the CLI loop**, which exercises discovery, config, trust, and
context building:

```sh
orcaops eval test --print-example-fixture > fixture.json
orcaops eval test --ref <pack>/<id> --fixture fixture.json --no-llm
```

The fixture file is **not** a context. It is a storage-input shape —
`plan`, optional checkpoints, optional summary — that the CLI turns into
a disposable store and then a context. `runFixture()` takes a context;
`orcaops eval test` takes this file. Different shapes, different keys.
Start from the emitted example rather than writing one.

**Third, optional — one real provider run.** `--no-llm` skips LLM
evaluators; there is no positive opt-in flag, so you spend a provider
call by RERUNNING WITHOUT `--no-llm`. **Ask the human before doing
that.** It exists for one thing the fixture loop structurally cannot
detect: a model that ignores the sentinel instruction. If the prompt is
unchanged since the last real run, skip it.

# 9. Where each shape comes from

Do not copy a shape out of documentation. Every one is reachable.

**Start from the exemplars.** `--example` prints a commented, ready-to-paste
file; the bare form prints the field reference. The two answer different
questions — "what do I write" versus "what is allowed" — and you usually want
the first, then the second when a field surprises you. The manifest exemplar
also carries the directory layout, which no schema can express.

| Shape | Get it from |
| --- | --- |
| a spec file to start from | `orcaops eval schema spec --example` |
| a manifest, and the pack layout | `orcaops eval schema manifest --example` |
| the spec field reference | `orcaops eval schema spec` |
| the manifest field reference | `orcaops eval schema manifest` |
| the result envelope | `orcaops eval schema result` |
| the evaluator context | `makeContext()`, which parses through the real schema |
| a plan step | `makePlanStep()` |
| a result | `pass()` / `violation()` / `info()`, or `writeResult()` |
| the test fixture file | `orcaops eval test --print-example-fixture` |

The Zod schemas are public API too — `EvaluatorSchema`,
`EvaluatorPackageSchema`, and `EvaluatorResultEnvelopeSchema` are
exported from `@orcaops/evaluator-protocol` if you want to validate in
your own tests. `orcaops eval schema` is a structural view of those;
orcaops parsing is what actually decides.

For the command entry point use `runIfDispatched()`: it reads and
validates the context only when the runner dispatches the module, so
your pure-function tests import the file without writing output or
changing the exit status. Unexpected errors are diagnostics, not
findings — let them throw rather than returning a violation.

# 10. Stop here

Register the pack against the working tree and hand back:

```sh
orcaops eval add-pack ./path/to/pack <pack-id> --disabled --dev --yes
```

`--dev` binds the grant to the resolved path, which is exactly the
author-iterating case: editing specs or prompts changes the pack
fingerprint and would invalidate a normal grant on every edit. It is one
command on purpose — registering first and granting after would mint a
durable fingerprint grant in between, which is the very thing the next
paragraph forbids. `--dev` needs `--yes` beside it because it does not
imply consent, and it only applies to a path source.

**Do not go further.** Specifically:

- Do NOT grant non-`--dev` trust. That grant outlives this session.
- Do NOT run `orcaops eval enable`. Enabling puts the evaluator in the
  human's capture path, where a `block` severity stops their next
  commit.

Report what you built, the verdicts your tests produced, and the two
commands the human would run to turn it on. The decision to let a new
evaluator interrupt real work is theirs.

Related: `orcaops-doctor` diagnoses a pack that
registers but does not discover.
