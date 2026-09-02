# Evaluator consent

How the CLI decides whether an evaluator pack may run. This page records the
invariants the code enforces; [`SECURITY.md`](../SECURITY.md) states the trust
model they serve, and the [Evaluators guide](../apps/docs/content/evaluators.md)
covers the user-facing workflow.

## Principle

Repository config is not authorization. `.orcaops/evaluators.yaml` declares and
enables evaluators; consent lives with the user, keyed to content that changes
when covered declared pack files change. Missing or stale consent fails closed
at dispatch.

## Grant store (user-local)

- Location: `<config-home>/evaluator-grants.json` where config-home is the same
  XDG-resolved directory as credentials (`ORCAOPS_CONFIG_HOME` override
  honored). Never inside the repository; never read from repo config.
- Mutations share the config home's cross-process lock, replace the file
  atomically, and fsync both the new bytes and, where supported, its directory
  entry. On POSIX, reads and writes require current-user ownership and private
  directory/file modes (repairing widened modes where possible); a symlinked or
  otherwise non-regular grants file fails closed.
- Versioned schema `{ v: 1, grants: Grant[] }` where Grant is one of:
  - `{ kind: 'fingerprint', source_fingerprint, capabilities: Capability[], granted_at, package_id }`
    — binds the covered declared pack-file bytes listed below plus the capability
    set. Changed covered bytes = no grant.
  - `{ kind: 'workspace-dev', resolved_path, capabilities, granted_at, package_id }`
    — explicit dev grant for a workspace pack whose bytes churn during
    development; bound to the absolute resolved path, user-local, never
    inherited by a clone at another path. Written only by an explicit
    `orcaops eval trust --dev` style action, never automatically.
- Capabilities are validatePack's warning codes:
  `command_evaluators_present`, `llm_evaluators_present`, and
  `file_reading_llm_evaluator_present`. Every LLM requires the LLM capability
  because it sends capture context through the user's authenticated provider;
  file-reading LLMs require both LLM capabilities. A grant lists exactly what
  the user accepted. Evaluator packs are trusted executable code: unless the
  host independently confines a process, it has the invoking user's ambient
  access.

## Verification flow

1. The CLI (`evaluator-bridge`) discovers evaluators from
   `.orcaops/evaluators.yaml` and the packs it registers.
2. For each eligible pack, the CLI computes the pack's declared-pack-file
   fingerprint (`computePackSourceFingerprint` over the covered bytes) and its
   required capabilities — from the pack's evaluators' engine kinds/spec AND
   the resolved default LLM provider, because an evaluator declaring neither
   `provider` nor `tool_policy` still reaches Codex's file-reading tools when
   the configured default resolves to codex. One classifier
   (`requiredTrustCapabilities`) makes this call everywhere consent is
   classified — dispatch, grant-time validation (`eval trust` / `add-pack` /
   `update-pack`), doctor, and the dist build's installation manifest (which
   classifies with codex assumed, since a shipped manifest cannot know a
   future user's config).
3. Trust resolution is fail-closed:
   a. **Fingerprint-bound authorization**: a matching built-in manifest entry
   and a matching user-local fingerprint grant contribute the union of their
   capabilities. The union must cover each evaluator's required capability at
   dispatch. This lets an explicit user grant add a capability omitted by an
   otherwise matching shipped manifest without allowing either source to
   authorize different covered pack-file bytes. A manifest entry matches only
   when the pack resolves from the CLI installation's own dependency tree and
   the entry names this exact package+pack+fingerprint; a user grant matches
   only when `grant.source_fingerprint` equals the resolved fingerprint. A repo
   yaml entry with `kind: bundled` grants nothing by itself. Installed
   resolution must anchor at CLI_ROOT, never the repository's node_modules.
   b. **Workspace-dev grant**: resolved path equals grant.resolved_path and
   capabilities cover (workspace path source only).
   c. Otherwise → the pack's capability-requiring evaluators are REFUSED:
   recorded as loud `CONSENT_DENIED` error runs naming the grant command,
   never executed. Refusal rows are not disposition-eligible policy findings;
   a block-severity refusal still halts lifecycle progression until consent is
   granted, while warn/info refusals remain visible in run listings and doctor.
4. The CLI passes the verified per-pack trust decisions into
   `dispatchEvaluators`, which requires them. The runner stays non-interactive
   and enforces: an evaluator whose pack decision is not `trusted` and whose
   engine requires a capability never reaches its engine. Defense in depth:
   the runner refuses rather than trusts-by-default when the input is absent.

Fingerprint and capability values identify a grant; they are not proof of
consent. They are public and computable by a hostile repository, so no
repo-controlled flag, yaml field, or environment variable can mint a grant —
authorization exists only in the user-local store or the installation manifest.

## Built-in (installation) trust manifest

- Shipped file inside the CLI package (`dist/trust-manifest.json`), generated
  by the dist builder AFTER pack install+minification
  so fingerprints bind to the final installed covered pack-file bytes.
- Entries: `{ package, pack, source_fingerprint, capabilities }`.
- Workspace development has no shipped manifest → workspace packs need the
  explicit dev grant (or fingerprint grant re-granted per covered change).
- Changed covered installed pack-file bytes → fingerprint mismatch → fail
  closed. Mismatched or absent manifest → fail closed. Changes outside the
  covered set are not detected by this mechanism.

## Grant lifecycle

- `eval add-pack` writes a user-local grant after consent — fingerprint-bound by
  default, or workspace-dev with `--dev`, which binds to the resolved path and
  applies to path sources only. `--dev` registers and grants in one act so a
  non-interactive caller never has to take a fingerprint grant and replace it
  afterwards; it does **not** imply `--yes`, because a path-bound grant trusts
  whatever that path later becomes. `eval update-pack`
  revokes a fingerprint grant when covered pack files change, and revokes any
  grant when the pack no longer contains capability-requiring evaluators;
  re-granting remains an explicit `eval trust` or `add-pack --force --yes`
  action.
- `orcaops eval trust <pack>`: inspect + grant explicitly; `--dev` is for
  workspace packs. `orcaops doctor` reports enabled packs whose shared
  dispatch gate would refuse them.
- The manual `scripts/smoke-cli-linux.sh` proves the manifest path end to end:
  it installs the packaged CLI, adds the bundled core pack with no `--yes` and
  no repo-provided grant, captures a plan, and requires a completed
  command-engine evaluator run. CI does not run this script.

## Named residuals

- **Fingerprint coverage is declared pack files, not the executed code
  closure.** The source fingerprint covers the manifest, specs, command
  arguments that resolve to pack-contained regular files, description files,
  prompts, and `fingerprint.include` entries. Imported dependencies of runtime
  files, data files a runtime reads without declaring, relative command
  arguments executed from the repository working directory, and the
  interpreter binary resolved from `PATH` are OUTSIDE it —
  changing those does not invalidate a grant. An explicitly relative
  `command[0]` (`./` or `../`) is instead pack-resolved and fingerprinted.
  Packs whose runtimes read extra inputs should enumerate them via
  `fingerprint.include`. Broad directory selectors such as `**/*.mjs` skip
  external directory symlinks they encounter incidentally (for example a
  workspace `node_modules`); literal paths, character-class and brace-range
  spellings, finite brace/extglob alternatives, and named descendants after a
  wildcard conservatively fail containment. Simple negated extglobs
  remain broad. This classifier can refuse an external symlink that a broad
  pattern might not ultimately match; it never follows that link to decide.
  The installed CLI bundles the eval packs themselves, but the fingerprint
  covers a pack's declared files — not its whole runtime closure. `typescript`
  (which the js pack's `api-signature-drift` runtime imports) ships inside the
  tarball as part of that closure, so it is frozen by the build, but its bytes
  are outside the fingerprint a user grants.
- **Non-interactive granting is an agent-mediated act.** `eval trust --yes`
  and `add-pack --yes` exist for explicit human-delegated automation; a
  hostile repository that can already drive your agent into running
  arbitrary commands can drive these too. The grant-store containment above
  removes the repo-controlled STORE channel; the command channel is bounded
  by the same trust you place in what your agent executes.

## Non-goals

- No blanket noninteractive bypass (no `ORCAOPS_TRUST_ALL`-style boolean).
- No repo-scoped grant files (a relative or repo-contained
  `ORCAOPS_CONFIG_HOME` is refused for grant reads).
- Event-ID validation and path containment are separate controls; the consent
  gate does not stand in for either.
