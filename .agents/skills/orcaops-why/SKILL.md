---
name: "Orcaops: why code is the way it is"
description: "Trace why code is the way it is — a line, a symbol, a file, or a whole subsystem — back to the captured artifact + checkpoint behind it. Invoke before reading the code. Use when the user asks \"why does X exist?\" (any symbol/file/concept), \"why is this built this way?\", \"where did this come from?\", \"who/what added this line?\", \"who owns this code?\", \"what is the history behind this file?\", \"how did this evolve?\", \"what was the rationale for this validator/handler/middleware?\", or wants captured context on a specific change — including debugging a regression through its captured provenance: \"why is this line here?\", \"what was the agent worried about when it wrote this?\", \"which change broke this and what was the rationale?\""
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "6cfec00c4ba1"
---

# When to use

Invoke when the user wants to know **why something exists** — what
captured artifact, plan step, and decision produced it. Bridges git
blame to orcaops's richer "why" context (the captured plan, the
checkpoint summary, the decisions made at the time).

`why` locates the work — which artifact, checkpoint and commit. Read what
it points at before you answer.

The underlying surfaces are `orcaops why <file>` and
`orcaops why <file>:<line>`. The skill
fires for **four shapes** of question:

**Shape 1 — explicit file:line.** Direct invocation. Examples:

- "why was this line written?", "blame plus context for X.ts:42"
- "trace src/api.ts:117", "where did this line come from?"

**Shape 2 — named symbol or concept.** The user names a function /
validator / class / middleware / endpoint without giving a line. The
skill is still the right answer — locate the symbol's definition via
`grep` (or the agent's symbol search), then run `orcaops why` against
the resulting `<file>:<line>`. Examples:

- "why does the parseLimit validator exist?"
- "what was the rationale for the rate-limit middleware?"
- "why do we have a sensitive-scope-flag evaluator?"
- "why is the digest caching layer there?"

**Shape 3 — a whole file.** The user names a file with no line and no
symbol ("what's the history behind this file?", "who owns this module?",
"what work has touched src/api.ts?"). Pass the bare path: `orcaops why
<file>` is whole-file mode, which lists every checkpoint that claimed the
file, newest first. That IS the answer to a file-history question — it is
an aggregate, not a ranking, so read it as a timeline and do not treat the
first entry as the file's author.

**Shape 4 — a subsystem or concept.** "Why is the navigation built this
way?", "how did the sync layer end up like this?" No single file:line
answers it. Pick two or three entry-point files and run whole-file mode on
each. Read the oldest entry and the entry whose summary names the concept
before the newest — the founding checkpoint carries the constraint the
design is built around; later ones carry adjustments to it.

Choose the shape by the question, not by the target. "Why is this file
the way it is?" spans both: run whole-file for the arc, then anchor the
specific thing being asked about — the export, the regex, the branch — on
its line, where a match the history actually authored comes back
`exact`. Reaching for the bare path when the user asked about one line
throws away the line evidence; reaching for a line when they asked about
the file answers a narrower question than they posed.

If the user names a symbol, **do not** answer from the code's structure
alone — that misses whatever captured plan, decisions, and uncertainty
`why` can surface. Locate the definition site, then invoke. The converse
holds just as hard: do not answer from the artifact alone either.

# How to invoke

The user gives you either a file + line or a symbol name. For a symbol,
locate `<file>:<line>` first. Then:

```bash
orcaops why <file>                            # complete history, newest first
orcaops why <file> --all                      # same history with expanded detail
orcaops why <file> --json                     # complete machine-readable history
orcaops why <file>:<line>                     # best match (highest confidence)
orcaops why <file>:<line> --all               # every line candidate
orcaops why <file>:<line> --branch feat/x     # restrict to one branch
orcaops why <file>:<line> --json              # machine-readable
```

# Interpreting the output

Read `mode` before `confidence`. The tiers below grade a LINE-mode
attribution. Whole-file mode attempts no attribution, so every entry is
`weak` by construction — there it is a lane marker, not a quality signal,
and reporting a whole-file result as "low confidence" misreads a complete
answer as a poor one. For a whole-file result, report the count and the
ordering instead.

**Line mode** (`mode: "line"`) — each result has a **confidence label**:

| Label | Meaning |
|---|---|
| `exact` | The line was added by exactly one checkpoint's diff. High signal. |
| `likely` | The line existed in the file when the checkpoint was captured (forward or retroactive ancestry holds). |
| `weak` | The artifact touched the file but the specific line's attribution is uncertain (parallel branches, multiple touches). |
| `none` | No captured artifact touched this file. Fall back to `git blame` directly. |

**Whole-file mode** (`mode: "whole-file"`) — no tier applies. The result is
every checkpoint that claimed the file, newest first. JSON always carries the
complete history in `all`; human output is compact by default and `--all`
expands the same checkpoints with full captured detail.

On an imported store `exact` usually resolves as "checkpoint head_sha
matches blame commit" — that is `git blame` with a summary attached. Read
the `reason` field, not just the label.

For `exact` / `likely` matches: surface the artifact's plan task,
checkpoint summary, and any decisions — then corroborate (next section)
before you answer. For `weak` or `none`: note the uncertainty, don't
fabricate context.

`[imported]` / `origin:git-import` artifacts are synthesized from commit
history: their summaries describe what changed. `uncertainty[]` and
checkpoint decisions are empty on them. Plan decisions, where present, are
reconstructions anchored to a quoted commit — cite the commit alongside
the decision so the reader can see what it rests on.

Pair with the `orcaops:show` invocation for the full artifact thread,
or `orcaops-digest` for the broader PR picture.

# Before you answer

**Look at what the matched checkpoints touched.** If `files_changed`
includes prose files, this repo keeps a written record and it will be
richer than any summary — go read it. If it is code and tests only,
orcaops is the written record here, and its output is close to all there
is.

**Corroborate against a source `why` did not name** — the code it changed,
the commit bodies, the tests, whatever written record the repo keeps. The
artifact points; it does not explain.

**Say what you could not find written anywhere.** An undocumented decision,
or a constraint the design is built around that nothing justifies, is worth
more to the reader than a confident guess at the reason.

**Check for lineage drift.** `why` does not report it; `orcaops show
<artifact_id>` does, as "N commit(s) since artifact_head touch artifact
files". When it fires, read what changed
(`git log <artifact_head>..HEAD -- <paths>`) before answering, or you will
describe code as it used to be.

# On a miss in a repo with imported history

A `none` result — or a CLI hint saying the line's history isn't
imported — in a repo whose store carries imported artifacts is a
coverage gap, not a dead end:

1. Recommend the user-invoked `orcaops-seed` skill for the
   gap, passing the implicated commit or path along as context
   (`orcaops seed --commit <sha>` / `orcaops seed --path <dir>`).
2. Record the offer you just made, so it is not repeated during the
   cooldown:

   ```bash
   orcaops seed status --offered <area>
   ```

   This is the sanctioned offer write (the same one the
   `orcaops-seed-discovery` lane records) — it stamps only
   the offer timestamp that suppression reads and touches no repository
   file, so run it even under a read-only posture. Skip it only when the
   hint says imports for the area were DECLINED: the way back
   (`orcaops seed status --offer-again <area>`) is the user's call.

# Regression lens (debugging through provenance)

When a test/behavior regressed and a suspect line or file is in hand,
chain the `why` match to the checkpoint's PRE-REGISTERED hypotheses.
(You don't yet know WHERE it broke? → `orcaops-timetravel` bisects
checkpoint boundaries with a failing test first.)

1. **Provenance of the failing line:** `orcaops why <file>:<line> --json`
   (or whole-file mode). Check `mode` first — on `whole-file` the tier is
   not a quality signal, so report the timeline rather than a confidence.
   In line mode read `best.confidence` honestly: `exact` with
   the line-content-hash reason is authorship-grade (the checkpoint's
   manifest contains this exact line); ancestry-based `likely`/`weak`
   means "this checkpoint touched the file around then" — say which you
   have.

2. **The pre-registered hypotheses.** Steps 2 and 3 exist only on a
   live-captured store — on an imported one `uncertainty[]` is empty and
   decisions are reconstructions anchored to a quoted commit, so the lens
   degrades to step 1 plus ordinary debugging. From the matched checkpoint(s) (or
   `orcaops show <artifact_id> --json`), read `uncertainty[]` — the
   agent recorded what it was NOT sure about at close. An uncertainty
   entry naming the failing behavior is the headline: the bug was
   pre-registered, and the fix should resolve that uncertainty
   explicitly.

3. **The rationale.** `plan_decisions` + `checkpoint_decisions` on the
   match carry the why (and the rejected alternatives). A fix that
   contradicts a recorded decision needs to say why the decision no
   longer holds — route it through a plan revision or a new decision,
   not a silent reversal.

4. **Deliver:** the culprit line's provenance (artifact, checkpoint,
   confidence + reason), the matching uncertainty entries verbatim, the
   load-bearing decisions, and the proposed fix's relationship to both.

Where a checkpoint has no fingerprint manifest, the line-hash tier can't fire — `why` still
answers from `files_changed` + git ancestry. Never present file-level
overlap as line-level authorship.
