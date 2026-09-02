---
description: 'Install, create, trust, configure, and update rule-based and judgment checks for captured work.'
---

# Evaluators

Evaluators grade a captured session against its plan — catching scope creep,
under-delivery, missing tests, and unsurfaced uncertainty. They ship as
**packs**: collections of evaluator specs plus the prompts and code that execute
them.

In the product vocabulary, **rule-based checks** are command-engine evaluators:
deterministic programs for requirements that can be expressed reliably in code.
**Judgment checks** are LLM-engine evaluators for questions that need language
reasoning. Their results contribute evidence to a completion check; Task Review
is the separate branch-review workflow that inspects both code and the captured
account.

## Choose an evaluator pack

Evaluator packs are optional. Fresh configuration installs none, and the local
capture workflow still works without them. Core capture invariants do not
depend on a pack: secret refusal, completion evidence, nonblank prose, and plan
revision integrity remain enforced when no evaluator is installed. You can
verify the evaluator state directly:

```bash
orcaops eval list
```

<!-- cli-output:eval-empty:start -->

```text
No evaluators discovered. Run `orcaops eval add-pack @orcaops/evaluator-pack core` to install the default first-party pack.
```

<!-- cli-output:eval-empty:end -->

If you want supplementary first-party checks, install the `core` pack for plan
quality, checkpoint scope, conformance, uncertainty surfacing, scope and
non-goal analysis, and delivery analysis. These evaluators add feedback around
the core write-time invariants; they do not define whether a completion claim
or secret-bearing operation is accepted. The conformance evaluator grades the
session against its captured plan—or, when the plan was
[reviewed and attached to the task](./plan-review.md), against the version your
reviewer approved:

```bash
orcaops eval add-pack @orcaops/evaluator-pack core
```

The optional **`js`** pack adds the API-signature-drift analyzer (it pulls in
`typescript`):

```bash
orcaops eval add-pack @orcaops/evaluator-pack js
```

Run `orcaops eval list` again after installing a pack. It reports every
discovered evaluator's severity, lifecycle phase, engine, enablement, and
reference; judgment checks also show the resolved provider, model, and timeout.

## Create an evaluator with your agent

Invoke the `orcaops-author-evaluator` skill explicitly and describe the rule you
want to enforce:

```text
Use orcaops-author-evaluator to add a checkpoint-close check that blocks a
database migration when the plan has no rollback step.
```

The skill takes the evaluator from an idea to a tested development pack. It:

1. defines the behavior, lifecycle phase, and severity;
2. chooses a deterministic command engine unless the judgment genuinely needs
   language reasoning;
3. creates the pack manifest, evaluator spec, implementation or prompt, and
   remediation message;
4. tests the evaluator directly through the SDK and through `orcaops eval test`;
   and
5. registers the local pack in disabled development mode.

For an LLM evaluator, the skill also makes the provider-visible context explicit
before authoring the prompt. LLM evaluators can send captured task content and
declared context sections to the selected model provider; command evaluators run
locally and are the better fit for rules that can be expressed reliably in code.

The skill stops before durable trust or enablement. It reports what it built,
the test verdicts, and the exact commands you can run after reviewing the pack.
Turning on a new evaluator—especially one with `block` severity—is a user or team
decision because it changes the capture path.

Use [Authoring evaluator packs](./authoring-evaluator-packs.md) when you need the
manual schemas, directory layout, engine protocol, or distribution details.

## Enable and disable evaluators

```bash
orcaops eval enable  core/step-coverage
orcaops eval disable core/step-coverage
```

`orcaops eval add-pack` seeds every LLM-engine evaluator **disabled**, so
adding a pack never starts spending on a model without you asking. The three
`core/plan-conformance-*` evaluators are LLM-engine, so pinning a plan with
`--source-plan` does not make them run: until you enable them, the digest
reports that a source plan is pinned and plan-level conformance is unverified,
and names this file as where to change it.

As a pack _user_ you control which evaluators are enabled, their severity, and
the operational LLM provider, model, and timeout used by each LLM evaluator.
Set those three engine fields in `.orcaops/evaluators.yaml` without copying the
pack:

```yaml
evaluators:
  core/plan-conformance-pre-pr:
    enabled: true
    engine:
      provider: codex
      model: gpt-5-codex
      timeout_ms: 180000
```

Set `provider: null` to clear a pack's provider pin and return to the global
`llm.tool` selection. Set `model: null` to clear both a pack model pin and the
global model for that evaluator, letting the selected CLI use its own default.
The timeout cascade is user override, pack spec, then pack-manifest default.
`orcaops eval list` shows the configured value and source for each choice, plus
whether the resolved provider is installed. An unavailable provider produces a
visible skipped run; Orcaops never silently falls back to another provider.

Changing the provider can change the evaluator's required trust capabilities.
Repository config cannot authorize those capabilities: if the override needs
more than the current grant covers, run `orcaops eval trust <pack>` to inspect
and record an updated user-local grant. Consent is checked before provider
availability, so an unavailable provider never bypasses trust.

Effort, cost ceilings, prompts, output contracts, and tool policy remain
pack-author settings. Fork the pack when you need to change those:

```bash
orcaops eval fork-pack core --to ./orcaops-evaluators-core
```

## Updating packs

Third-party evaluator packs are trusted executable code. Command evaluators and
processes they launch run with your permissions; Orcaops does not sandbox or
confine them to the repository. Explicit consent is required before they run.
The consent fingerprint covers the pack manifest, evaluator specs, referenced
description and prompt files, pack-contained regular files named by
`engine.command[]`, and `fingerprint.include` matches. It does not cover
PATH/system interpreters, imported dependencies that are not separately
declared, later command arguments resolved from the repository working
directory, undeclared data files, or other runtime state.

```bash
orcaops eval update-pack <pack>
```

If a covered declared pack file has changed since you trusted it, the
fingerprint-bound grant no longer matches and its capability-requiring
evaluators are refused at dispatch until you re-inspect and re-grant with
`orcaops eval trust <pack>`.

That is true of fingerprint-bound grants, which is what you get by default.
There is one other kind: `orcaops eval trust <pack> --dev` binds the grant to
the pack's directory instead, so edits do not invalidate it. It is accepted
only for a pack you point at by path — never for a bundled or installed one —
and it does not follow a copy of the same pack to another location. Use it
while authoring a pack, where the fingerprint changes with every keystroke;
outside that, a mismatch is the signal you want.
Grants are user-local (stored beside your credentials, never in the
repository): a cloned repo's checked-in configuration can declare and enable
evaluators but can never authorize them. Built-in packs shipped with the
installed CLI are covered by its installation trust manifest instead.
`orcaops doctor` reports per-pack grant status.

## Register an existing custom pack

Custom evaluators live in a pack with a `package.yaml` manifest; repository
directories are not scanned implicitly. Register a local pack explicitly, then
confirm discovery:

```bash
orcaops eval add-pack ./my-evaluator-pack
orcaops eval list
```

The manifest and evaluator-spec schemas match the first-party packs. Use
[`orcaops-author-evaluator`](#create-an-evaluator-with-your-agent) when the pack
does not exist yet.
