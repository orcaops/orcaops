---
description: 'Diagnose installation drift, cache compatibility, evaluator discovery, and other common Orcaops failures.'
---

# Troubleshooting

Start by asking your agent:

```text
Diagnose my Orcaops setup.
```

The `orcaops-doctor` skill runs the relevant installation, runtime,
authentication, evaluator, cache, and Orcaops Watch checks, then reports the specific
problem and recovery in terms you can act on.

For direct terminal diagnosis, run:

```bash
orcaops doctor
```

The command prints the same underlying checks and is useful for automation or
when agent support is unavailable.

Healthy checks are condensed by category, while a warning includes the concrete
next action. For example:

<!-- cli-output:doctor-seed-warning:start -->

```text
orcaops doctor — v<version>
  repo: <repo>

✓ repository           8 checks passed
✓ install surfaces     9 checks passed
✓ artifact state       20/21 checks passed
  archive-redaction: archive mirror stores event text verbatim (archive.redact_secrets: false)
    The mirror is outside the repository and outside .gitignore, and survives deleting the worktree. Set archive.redact_secrets: true to redact the copy — a cold-start `orcaops resume` then restores the redacted text.
⚠ seed                 git history exists but Orcaops has never been seeded
  Preview with `orcaops seed --dry-run`; apply with `orcaops seed --yes` or `orcaops doctor --fix`.
✓ evaluator health     9 checks passed
✓ pins and shell       6 checks passed

Overall: WARN (1 warning(s))
```

<!-- cli-output:doctor-seed-warning:end -->

## Install drift or stale generated files

After upgrading the CLI, run:

```bash
orcaops update
orcaops doctor
```

`doctor` checks generated skills/commands, the managed instruction block, naming
prefix consistency, generated-files mode, and global install health.

For project-scope installs, `doctor --fix` repairs missing or stale generated
files and the managed instruction block through the same guarded mutation path as
`init` and `update`:

```bash
orcaops doctor --fix --dry-run
orcaops doctor --fix
```

`--dry-run` previews the repair and does not claim the repo is healthy until you
run the real fix.

For global-scope installs, `doctor --fix` does not materialize global files. If
the `global-install` check says this repo has no current global materialization,
run:

```bash
orcaops update --scope global
```

### Personal manifest is stale or unsafe

If the common-dir `orcaops/personal-manifest.json` is malformed, stale, or
redirected through a symlink, `update`, `uninstall`, and `doctor --fix` stop
instead of guessing whether another worktree still needs the shared
`.orcaops/` exclusion. Inspect the reported path, remove it only after
confirming it is stale, then run `orcaops init --personal` from a worktree that
should remain personal before retrying the interrupted command.

## Local cache needs rebuilding after an upgrade

`.orcaops/cache/orcaops.db` is an untracked, disposable projection of captured
event logs and usage records. When Orcaops Watch finds a cache created by an
older Orcaops version, it offers to rebuild it before opening **Review**. The
rebuild does not change captured history.

Headless or scripted review generation never prompts. Authorize the same rebuild
explicitly:

```bash
orcaops review data --branch <branch> --rebuild-cache
```

Use `orcaops rebuild` instead when you want to rebuild the repository cache
without opening Review. A cache created by a **newer** Orcaops version is never
rebuilt backward; upgrade the running Orcaops installation instead.

Orcaops supports one active installed binary version at launch. Running older
and newer binaries against the same worktree simultaneously is unsupported: a
cache rebuilt by the newer binary can be unreadable to the older one.

Configuration scope and generated-file posture are separate from cache
compatibility. See [Agent integrations](./agent-integrations.md#install-scope)
for tracking behavior and
[Generated files](./agent-integrations.md#generated-files) for the
`generated_files: "ignore"` option.

### Project-managed path is a symlink

Project-scoped installs reject symlink components in managed roots such as
`.claude` and `.agents`, even when the link stays inside the repository. Earlier
versions could follow these redirects. Replace the redirected root with a real
directory, then run `orcaops update`.

The same fail-closed rule applies to `.orcaops/evaluators.yaml`. A redirected
individual generated file is preserved as user-owned, so `orcaops update` will
not replace it and the materialization reminder will remain until the link is
replaced by a regular file.

This does not affect instruction-file links created by `orcaops link` or global
skills installed with `--link symlink`; those links are explicit Orcaops
materialization choices with separately bounded roots.

## "No evaluators discovered"

The default pack isn't installed. Run:

```bash
orcaops eval add-pack @orcaops/evaluator-pack core
```

## Grading can't find or run the pack

The pack ships as a real on-disk package alongside the CLI. If grading can't
locate it, the installation is incomplete — reinstall Orcaops through the current
installation channel rather than copying the binary around, then re-run
`orcaops doctor`.

## `better-sqlite3` tries to compile on install

Your platform has no prebuilt binary. Pin Node to a 22.x release, or install
build tools (Xcode Command Line Tools on macOS; `build-essential` + `python3` on
Linux) and reinstall. A prebuilt is fetched automatically on supported platforms
(macOS and Linux, x64/arm64) with Node ≥ 22 and network access.

## Login problems

```bash
orcaops whoami        # are you actually signed in?
orcaops login         # re-authenticate
```

- **`login` can't open a browser (headless / SSH):** SSH-forward the loopback
  port the CLI prints, or export an `ORCAOPS_TOKEN` issued for the official
  Orcaops Cloud.
- **`login` hangs or times out:** make sure outbound HTTPS to `api.orcaops.ai` is
  allowed (corporate proxy / egress firewall).
- **Unexpected keychain prompts:** the default is a file store; prompts only
  appear if `ORCAOPS_CREDENTIAL_STORE=keyring` is set — unset it.

`orcaops doctor` includes a cloud-auth check that separates a stale token from a
network or endpoint problem.

## Plan review: "NOT_FOUND" on pull, or the wait times out

Both usually mean the plan **isn't approved yet** — not that something broke.
Pulling a plan returns `NOT_FOUND` until a human has approved a version on the
web, and the agent's wait for approval expiring (exit code 2) is just the
bounded wait running out, not a failure. Re-check after your reviewer acts, or
ask your agent whether there's feedback — see [Plan review](./plan-review.md).

## Export refuses because one artifact is unreadable

`orcaops export agent-trace` attributes lines against **every** artifact in
the store, so a single corrupt artifact refuses the whole export — a partial
export would silently attribute against an incomplete ambiguity pool, which
is worse than no export. The refusal names the artifact(s); to recover:

- `orcaops doctor` — the event-log-corruption check names the corrupt
  line(s) and kind for each artifact;
- `orcaops archive resolve --artifact <id> --source archive --apply` —
  replace a corrupt hot log from the archive mirror (archive enabled);
- restore `events.ndjson` from a backup, then `orcaops rebuild`;
- if the artifact is expendable: delete its directory under
  `.orcaops/artifacts/`, run `orcaops rebuild` **immediately** (the cache
  row must go before anything else reads it — a stale row makes the
  deleted artifact look clean-and-empty, silently shrinking the very
  ambiguity pool this refusal protects), then
  `orcaops snapshots prune --orphans --apply` and `orcaops gc --apply`.

## Where are my artifacts?

Under `.orcaops/` at the **repository root** — Orcaops keys off the current
working directory, so run capture commands from the root of the repo.
