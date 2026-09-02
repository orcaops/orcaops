# @orcaops/evaluator-pack

The first-party evaluator packs shipped with orcaops. Three packs live
here:

| Pack         | What it is                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packs/core` | The default deterministic + LLM evaluators most users will want. Plan-quality, scope-density, coverage, and revision-stability checks. |
| `packs/js`   | TypeScript-specific evaluators for JS/TS projects — `api-signature-drift` uses the TypeScript compiler API.                            |
| `packs/demo` | Explicitly installed example-only content (pass / info / always-block) for pack authors; unsuitable as a workflow default.             |

Each pack is a self-contained directory with:

```
packs/<pack>/
├── package.yaml          # pack manifest (id, name, version, defaults)
├── runtime/              # TS source + compiled JS for engine.command entries
├── evaluators/           # *.eval.yaml spec files
└── prompts/              # *.prompt.md files referenced by engine.llm specs
```

TypeScript sources under `runtime/` compile into `dist/packs/<pack>/runtime/`.
The evaluator runner executes each compiled entry with the resolved pack output
as its working directory.

## Consuming packs

Packs are **opt-in**. `orcaops init` does not install packs; the
absence of `.orcaops/evaluators.yaml` is the explicit "no packs
configured" signal. Use `orcaops eval add-pack` to install:

1. **Bundled first-party packs** ship with the CLI install:

   ```
   orcaops eval add-pack @orcaops/evaluator-pack core
   orcaops eval add-pack @orcaops/evaluator-pack js
   orcaops eval add-pack @orcaops/evaluator-pack demo
   ```

   These resolve via the workspace's `dist/packs/<id>/` build outputs
   without a separate `pnpm add` step.

   `demo` is never installed by `orcaops init` and is not a production
   default. Its `demo/always-block` evaluator deliberately rejects every
   checkpoint open unless disabled or policy-excepted; install the pack only
   when studying evaluator engine and gate shapes.

2. **Third-party packs** install as a normal dependency, then register:

   ```
   pnpm add -D @scope/your-evaluator-pack
   orcaops eval add-pack @scope/your-evaluator-pack <pack-id>
   ```

3. **Local development packs** point `add-pack` at a directory path:

   ```
   orcaops eval add-pack ./sibling-pack
   ```

In every case `add-pack` writes/updates `.orcaops/evaluators.yaml`
declaring the pack in `packages[]` and enabling its evaluators in
`evaluators{}`. The yaml is owned by `add-pack` / `remove-pack` /
`enable` / `disable` but is plain text — hand-edits for severity /
params / enabled overrides are supported.

## Trust boundary

Evaluator packs are trusted executable code. Packs containing command-engine
evaluators run local subprocesses with the invoking user's permissions on your
repository state at capture time; Orcaops does not sandbox or confine them to
the repository. LLM-engine evaluators send captured context through your
authenticated provider and consume model credits.
`eval add-pack` requires explicit consent for
`command_evaluators_present` and `llm_evaluators_present`; an LLM that can
read the worktree additionally requires
`file_reading_llm_evaluator_present`. Pass `--yes` only after inspecting the
pack. Claude file inspection is limited by a command allowlist and secret-path
denylist, not by an OS sandbox or repository-confinement boundary.

The consent fingerprint covers the pack manifest, evaluator specs, referenced
description and prompt files, pack-contained regular files named by
`engine.command[]`, and `fingerprint.include` matches. It does not cover
PATH/system interpreters, imported dependencies that are not separately
declared, later command arguments resolved from the repository working
directory, undeclared data files, or other runtime state.

## Authoring new packs

See `apps/docs/content/authoring-evaluator-packs.md` for the contract surface
(`@orcaops/evaluator-sdk` + `@orcaops/evaluator-protocol`), a minimal
working example, fixture testing patterns, and trust-boundary
guidance.

The canonical spec / package / config schemas are the Zod schemas
exported by `@orcaops/evaluator-protocol`.
