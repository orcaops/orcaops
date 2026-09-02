# Security

This document states the trust model orcaops holds itself to, the current
status of its enforcement, where each boundary stops, and how to report a
vulnerability.

## Trust model

Three boundaries define how orcaops treats repository contents:

### 1. Repository config is not authorization

A repository declares and enables evaluators; it can never authorize them.
Orcaops computes a declared-pack-file fingerprint and the required capabilities
of each evaluator; the **user** grants that fingerprint, and the grant is stored
outside the repository. Changes to covered pack files invalidate a
fingerprint-bound grant, which is the default and the only kind a
repository can prompt for; the narrower `--dev` tier below is bound to a
path instead and deliberately survives edits.
Built-in evaluators shipped with the installed version are covered by a
separate built-in trust manifest over the same declared pack-file fingerprint,
anchored to the installation and never to repo-declared labels. Missing or
stale consent fails closed.

One narrower tier exists, for people authoring a pack: `orcaops eval trust
<pack> --dev` records a grant bound to the pack's resolved workspace path
rather than to its fingerprint, so edits to covered files do **not** invalidate
it. It is accepted only for path sources — a workspace directory you already
control — and never for a bundled or installed pack, and it does not transfer
to a copy of the same code at another location. Use it while you are editing a
pack, not to silence a mismatch.

There is deliberately **no blanket non-interactive bypass** (no
`ORCAOPS_TRUST_ALL=1`-style boolean): repository-controlled workflows can set
environment variables, so any such switch would let a hostile clone
self-authorize. A non-interactive fingerprint grant is bound to an exact
fingerprint plus capabilities and must be provisioned outside the repository.
Fingerprint and capability values identify a grant; they are not proof of
consent — both are public and computable by a hostile repository.

The grant store's own location is the boundary that holds this up, and it is
user-controlled: `ORCAOPS_CONFIG_HOME`, then `XDG_CONFIG_HOME`. The resolved
path must be absolute and outside the repository — a repo-pointing value would
let checked-in content mint its own consent — and the store additionally
refuses a directory owned by another uid, and forces `0700` on the directory
and `0600` on the grant file. A widened mode is repaired rather than rejected:
the store chmods it back and continues, and fails only if the chmod does not
take. These file-mode checks are POSIX-only; native Windows is not a supported
platform (see below).
Anything that can both set your environment and write outside your worktree is
already past this boundary. Treat control of your environment as equivalent to
consent.

**Status**: enforced. Evaluator dispatch fails closed: a capability-requiring
evaluator whose pack has no valid user-local grant (or installation-manifest
match, for built-in packs) records a `CONSENT_DENIED` refusal instead of
executing. Grant and revoke with `orcaops eval trust <pack>`. Known
boundary: the consent fingerprint hashes the raw bytes of a pack's manifest,
specs, contained prompt/description/command files, and declared
`fingerprint.include` inputs. Imported dependencies, undeclared data files,
relative command arguments executed from the repository working directory,
and the `PATH`-resolved interpreter are outside it. Every element of
`engine.command[]` that resolves to a regular file **inside the pack** is
fingerprinted — an explicitly relative `command[0]`, an absolute path that is
not an allowlisted interpreter, and any later argument under `cwd: package`
that names an existing pack file. Packs should enumerate extra inputs via
`fingerprint.include`. The distinction that matters is coverage, not shipping:
the tarball does bundle the eval packs and their production dependency closure
(`typescript` included), but the fingerprint still covers only the declared
pack files, so a change inside a bundled dependency is outside it.

Evaluator packs are trusted executable code. Command evaluators and processes
they launch run with the invoking user's permissions; Orcaops does not provide
an OS sandbox or a complete executable-closure integrity boundary.

### 2. Checked-in config cannot select storage locations outside the repository

Storage paths taken from checked-in configuration (`artifacts.path`,
`cache.path`) must stay inside the repository: absolute paths and `..`
escapes are rejected, and containment is enforced — resolved and
symlink-aware — at write and deletion boundaries. Product-managed locations
(git-dir, git-common-dir, and the documented home-directory roots) remain
legitimate because orcaops or the user-local installation selects them, never
repository contents. `install.scope` in `.orcaops/config.json` chooses among
those product-managed roots — `project`, `global`, or `personal` — but it
selects from a fixed set rather than supplying a path; the only path inputs a
repository can supply are the two named above.

**Status**: enforced. Every artifact-id-to-path construction passes through a
single sink that rejects unsafe id segments and resolves configured paths
through existing ancestors. Repository-managed hot artifact, cache-database,
usage, archive-sidecar, source-plan, plan-review, review-feedback, and watch-cursor
paths refuse symlink components, including dangling symlinks, rather than following
an in-repository link onto unrelated source or artifact data. `ArtifactStore` hot
reads and writes, usage-ledger IO, storage and review engine lock directories,
durable directory creation/chmod, projection renames, cache-database open, cloud
cache reads and writes, archive mirror/repair/restore hot-side operations, Watch
event reads, and recursive artifact deletion repeat the resolved check at their
filesystem boundary. Archive prune validates its `--project` / `--artifact`
arguments before building any path and re-checks containment at the removal itself.
Repository install mutations apply the same policy to generated skills and
commands, instruction files, install manifests, `.gitignore`, project
session-hook entries, Git hooks (including a `core.hooksPath`-designated
hooks directory, each candidate directory being its own containment root),
and `.git/info/exclude`; final generated-file replacements are preserved
without reading their targets. Non-symlink special entries at instruction
paths and non-regular hook entries are treated as conflicts and left
untouched. Instruction symlinks are classified separately and may be
re-pointed to the chosen canonical instruction file with a warning.

Machine-level session-hook registration writes user configuration outside
any repository (`~/.claude/settings.json`, `~/.codex/config.toml`) behind an
interactive consent boundary: only `orcaops session-hooks install` and the
interactive personal init may write there, ownership is claimed only by the
exact canonical hook command or a structurally valid managed marker block,
and user-authored entries are never rewritten. Symlinked user config files
are followed to their resolved regular-file target (dotfile setups are
legitimate); dangling links are refused. The consent record
(`~/.orcaops/hooks.local.json`) is bookkeeping written 0600 under the
orcaops global root — never the authority for what gets removed.

Containment is an explicit filesystem-operation policy: generic storage
primitives and product-managed home/archive locations do not infer a
repository boundary, so any new repository-local caller must supply one.
These are userspace path checks rather than an `openat(2)`-style kernel
sandbox; a process that can concurrently replace path components can still
race the interval between a check and the immediately following operation.
Use an isolated checkout or filesystem boundary when other local processes
with write access to the worktree are not trusted.

### 3. Capture does not carry a secret across a boundary the repository did not

A secret an agent reads out of the repository is the repository's problem —
orcaops did not create it, and refusing a capture cannot remove it. What
orcaops owes you is that capturing does not move it somewhere the repository
never went: into a cloud thread, into a home-directory archive that outlives
the worktree, or into a payload a reviewing agent's model provider reads.

Recognizable **vendor-issued credentials** are refused at the write boundary,
before anything durable exists — before the artifact directory, the idempotency
reservation, the git snapshot, the event append, the projections, and the push.
The same gate runs before the content hash on every outbound cloud verb that
mints one from author-written text, because refusing before the hash prevents
an anchor being minted where refusing after would be trying to un-mint one. The
remaining verbs either carry no authored text or carry text already refused at
the capture boundary, and the SDK-derived inventory test forces every method
into one of those classifications explicitly.

Detection is tiered, and the tier is the load-bearing part. Structural vendor
prefixes (`ghp_`, `sk-ant-`, `AKIA`, `AIza`, `xox*`, PEM blocks) refuse.
Structurally reproducible shapes — JWTs, `Authorization:` headers, bare
`Bearer` tokens, and secret-bearing query parameters — warn instead, because a
JWT is indistinguishable from a test fixture. A generic `key=value` assignment
is judged on its VALUE rather than on the label: one that carries credential
shape refuses, one that reads as an identifier warns, because the same matcher
fires on ordinary quoted code such as a TypeScript type annotation. Refusing on those would block an agent for citing its own
test evidence.

Two paths withhold rather than refuse, because there is no author to ask.
**Capture exclusion** keeps a named set of credential-bearing files out of the
snapshot tree — `.env`, PEM and key files, `.npmrc`, `.netrc`, SSH private keys
and service-account JSON, extendable per repository. It applies to UNTRACKED
files at capture time: a file already committed is in the tree the repository
chose to carry, and a snapshot taken before a pattern existed keeps whatever it
captured. Trackedness is measured against HEAD, so a `git rm --cached` that has
not been committed yet leaves the file tracked, and captured.

Capture is fail-open by contract and so is exclusion, in two modes that differ
in how much they say. An invalid pattern is dropped from the set, and only
`capture checkpoint open` says so — it returns a `capture-exclude-invalid`
warning naming each dropped pattern. Every other capture that resolves the set
takes the valid patterns and discards the rest silently: checkpoint close,
checkpoint abandon, the plan-time baseline, `diff`, `stats`, and the
`snapshots checkout` listing. On those paths a typo narrows the control
without a word. A worktree probe git refuses is the sharper case — that
snapshot is taken with no exclusion applied at all — and all three checkpoint
boundaries now say so, returning a `capture-exclude-probe-failed` warning; the
non-checkpoint paths above still take it silently. The review paths are the
exception in the other direction — the floor build and the dossier both refuse
a malformed exclude set before anything is pinned or minted. `snapshots
checkout` also re-runs the patterns against the recorded tree and lists each
match before writing it, rather than removing it, but it re-runs the same
narrowed set, so a pattern that never parsed matches nothing there either.

**Review scrubbing** redacts recognized secrets out of the DIFF a reviewing
model reads, while `diff.patch` on disk stays byte-exact because it is the
integrity anchor for manifest verification. It does not cover the account lane —
checkpoint summaries, decisions, uncertainty and criterion evidence — so
whatever warn-tier content capture admitted into those fields reaches the model
provider as written. Refusal at the capture boundary is what keeps refuse-tier
material out of them; there is no second pass behind it.

Text an author cannot rewrite is redacted rather than refused. Git history
imported by `orcaops seed` is synthesized from commits that already exist, so
there is nobody to ask for a reword; the same rule already governs evaluator
output, which is scrubbed at write.

**Status**: enforced at every capture verb, at the eight outbound cloud verbs
that mint a content hash from author-written text, at the block-disposition
reason and agent session id, and at the local source-plan pin.
A credential embedded in an http remote URL is not gated but stripped where the
remote is read, since it is not author-written and no reword would remove it. A completeness test
derives the cloud verb list from the SDK's own client type, so a method added
later fails a test rather than silently escaping the gate. Stated limits:

- This is an **accident guard, not an adversarial control**. It catches a
  credential an agent quoted from debug output, an env file, or its own logs.
  An agent that deliberately encodes one is out of scope, as it is today.
- The **durable archive mirrors event text verbatim by default**
  (`archive.enabled: true`, `archive.redact_secrets: false`), into the user's
  Orcaops data directory — outside the repository, outside `.gitignore`, and
  surviving deletion of the worktree. Warn-tier content capture admitted is
  therefore copied there as written. The default is deliberate: the mirror is
  what a cold-start `orcaops resume` restores from in a fresh checkout, and a
  redacted mirror is a lossy restore. `orcaops doctor` reports which of the two
  postures a repository is in.
- Detection is prefix- and keyword-shaped. An unlabelled high-entropy
  credential is not recognized by any pattern.
- The value test applies three conditions, in this order. A run of six or more
  identical characters vetoes first, and the value only warns however long it
  is, because a run like that is padding rather than a credential. Otherwise
  either of two branches refuses: 24 characters or more spanning at least three
  of lowercase, uppercase and digit; or 32 characters or more that are solid
  alphanumeric with a Shannon entropy of at least 3 bits per character. A
  credential clearing neither branch — a short one, for instance — only warns.
  Punctuation is deliberately not a character class: counting it made ordinary
  kebab-case and path-like identifiers refuse.
- The key name selects which values get tested; the value alone decides the
  tier. A credential-shaped value under `aws_secret_access_key=` or
  `client_secret=` refuses, closing a pair whose key id refused while its
  secret did not. Under those same keys a value clearing neither branch still
  only warns — one drawn from a single case plus digits and broken up by `/` or
  `+` spans two classes and is not a solid alphanumeric run. A realistic AWS
  secret is not that shape: it mixes case with digits, clears the first branch
  on three classes, and refuses. Punctuation cannot lower the count, because it
  is not counted.
- A 40-character lowercase hex git SHA is structurally indistinguishable from a
  hex API key, so it refuses when assigned to one of the credential-ish key
  names above — `secret=<sha>` refuses, while `commit=<sha>` and `sha=<sha>`
  are not matched at all, because the value test only runs on a recognized
  key. No rule spares the SHA without sparing the key; the corpus pins it as a
  known false positive rather than leaving it unexplained.
- That value test is safe only because it runs on the value half of a
  recognized `key=value` shape. The same predicate applied to arbitrary text
  matches a few percent of the strings in a real capture archive — measured at
  4.7% over 874,000 string values — and what it matches is ids, content hashes
  and refs, so widening the recognized key names to generic ones like `key`,
  `id`, `hash` or `digest` would break it.
- A refusal has one remedy besides rewording: `redact.allow`, a list of exact
  literal strings in repository config (`.orcaops/config.json`). Nothing at
  runtime stops an agent writing that file, so the guarantee is reviewability
  rather than restriction — and how much reviewability depends on the install
  scope. Under `install.scope` `project` or `global` the store is committable
  (the managed `.gitignore` block re-includes it), so an entry lands in a
  tracked file and shows up in the diff a reviewer reads, which is louder than
  the refusal it bypasses. Under `personal` scope — what a fresh `orcaops init`
  writes — `.git/info/exclude` hides the whole `.orcaops/` store and no orcaops
  write may touch a tracked path, so there is no diff to read: an entry is
  visible only to whoever added it, and its exactness is the only limit left.
  That narrowness is deliberate: an entry matches one exact detected
  string, never a pattern, a field or a path, so it cannot grow to cover
  anything nobody vetted. It is for a published example credential or a
  synthetic fixture someone has read and judged dead. The agent-facing refusal
  message does not mention it, because naming a bypass in front of an agent on
  every refusal trains reaching for it.
- Refusal guards writes made through orcaops. It does not scrub artifacts
  captured before it shipped, and there is no client-side delete for content
  already pushed. Rotate the credential; that is the only real remedy.
- A cloud-pulled, approved source-plan pin is deliberately exempt: its hash is
  the cloud's conformance anchor and the author cannot edit an approved plan.

## What this means in practice

- Repository-controlled evaluator code in a cloned repository cannot execute
  until you grant it (`orcaops eval trust <pack>`). A matching installed
  built-in-pack fingerprint may instead run under the installation trust
  manifest described above; repository declarations cannot extend that trust
  to different covered bytes. Still treat untrusted repositories with care — a
  pack you grant runs with your permissions, and the consent fingerprint covers
  its declared pack files rather than its full runtime closure.
- Credentials are stored user-locally by default (file store; keyring opt-in),
  outside any repository, and are not part of captured artifacts. Note the
  asymmetry with the grant store above: the credential path is **not**
  repository-containment-checked, so it follows `ORCAOPS_CONFIG_HOME` /
  `XDG_CONFIG_HOME` wherever they point. Do not point either inside a worktree.
- Captured artifacts record your session's plans, diffs, and evaluator
  output; treat them with the same sensitivity as the repository itself.
  Boundary 3 narrows that only for recognizable credential shapes — it is not
  a licence to treat an artifact as sanitized.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on this
repository: **Security → Report a vulnerability**, or
<https://github.com/orcaops/orcaops/security/advisories/new>. The report and
the discussion on it stay private until an advisory is published.

Please do not open a public issue for a suspected vulnerability, and please do
not disclose it publicly before a fix ships.

Include what you would want if you were fixing it: the orcaops version
(`orcaops --version`), your OS and Node version, the smallest reproduction you
have, and what an attacker gets out of it. A proof of concept is welcome but
not required — a clear description of the boundary you crossed is enough.

Expect an acknowledgement within a few business days. We will tell you whether
we consider it in scope, and we will keep you updated while a fix is prepared.
Reports are credited in the published advisory unless you ask otherwise.

### What is in scope

The trust boundaries above are what this document promises: repository config
that authorizes evaluator execution, checked-in config that reaches storage
outside the repository, and credential handling. A bypass of any of those is
in scope.

Out of scope, because they are documented properties rather than defects: an
evaluator pack you granted running with your own permissions, the fingerprint
covering declared pack files rather than the full runtime closure, and the
userspace path checks losing a race to another local process that already has
write access to your worktree. If you think one of those documented boundaries
is drawn in the wrong place, that is worth an issue — it is a design argument,
not an embargoed report.

## Supported versions

Security fixes land on the latest published minor of `@orcaops/cli` and ship
as a patch release. Earlier minors are not backported; upgrade to the latest
minor to receive them.

|                        | Supported    |
| ---------------------- | ------------ |
| Latest published minor | Yes          |
| Any earlier minor      | No — upgrade |

Supported platforms for those fixes:

| Platform                     | Status                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js >= 22                | Supported. The published package declares `engines: node >= 22`; older Node is unsupported and untested, but npm treats that as advisory and warns rather than refusing to install. |
| macOS (Apple Silicon, Intel) | Supported                                                                                                                                                                           |
| Linux (x64, arm64)           | Supported                                                                                                                                                                           |
| Windows                      | Supported through WSL2 only. Native Windows is not a supported platform, and reports specific to it are handled as ordinary issues rather than as vulnerabilities.                  |

`orcaops watch` additionally requires Bun; see the getting-started guide.
