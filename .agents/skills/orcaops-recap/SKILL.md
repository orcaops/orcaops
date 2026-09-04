---
name: "Orcaops: recap (standup / changelog / journal)"
description: "Summarize captured work over a time window or git range as a standup, changelog, or journal. Use for \"what did I do yesterday?\", \"changelog since v1.2\", \"draft the release notes\", or \"journal today\"."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "445646cb3d61"
---

# When to use

Triggers (user phrasing), by format:

- **standup** — "standup", "daily standup", "progress report",
  "what did I do yesterday?", "what did I do this week?",
  "what shipped this week?", "put together a client update"
- **changelog** — "changelog since <tag>", "what shipped between v1.2 and
  v1.3?", "draft the release notes"
- **journal** — "journal today", "update my dev log / NOTES.md",
  "append this week's work to the journal"

Pick the format by the ASK, not the window: a TIME window renders as
standup (chat) or journal (file); a git REF RANGE renders as changelog.

Skip when:

- The user wants to CONTINUE one task → `orcaops-resume`.
- The user wants the state of the current branch → run
  `orcaops status --json` directly.
- Reviewer-facing view of one PR / one artifact → `orcaops-digest`.

# Shared window discipline (standup + journal)

1. Compute the user's requested local calendar window first, then convert its
   start and end to explicit UTC instants for the CLI. Date-only values snap to
   UTC day edges, so use them only when the intended calendar window is UTC.
   For "yesterday" in another timezone, pass the corresponding ISO UTC start
   and end timestamps; for "this week", convert local Monday through now.
2. Resolve the artifact set with the bounded ACTIVITY window — **not**
   `--since` (started_at):

   ```bash
   orcaops list --all-branches --active-since <since> --active-until <until> --json
   ```

   Activity uses interval-overlap semantics: a checkpoint occupies
   [opened_at, closed_at/abandoned_at], a still-open checkpoint counts up to
   now, so a long-running artifact checkpointed across the window and a
   yesterday+today artifact both show up in a "yesterday" report.

   **Cross-project mode (archive):** when the report should span EVERY
   project on this machine (not just this repo), swap in
   `--all-projects` — it implies all branches (drop
   `--all-branches`/`--branch`), works from outside any repo, and tags
   each row with its `project`. From inside a repo or linked worktree, the
   current project includes both hot and retained archive history; duplicate
   artifact IDs use the freshest projection (archive only when strictly newer,
   tie to hot). Group the rendered report by project.
   Needs `archive.enabled`; per-artifact detail for OTHER projects comes
   from `orcaops decisions --all-projects --json` /
   `orcaops loose-ends --all-projects --json` rather than
   `orcaops show` (which reads the current repo only).

# Imported-history discipline

Label every artifact whose `origin.kind` is `git-import` as `[imported]`.
Treat imported decisions as evidence-cited paraphrases and include their
citation; do not present synthesized prose as captured reasoning. Attribute
imported work to `origin.authors`, never to the current user or agent in the
first person.

# Format: standup (chat-rendered progress report)

1. Resolve the window artifact set (above).
2. For each matched artifact run `orcaops show <artifact_id> --json` and,
   when rendering, keep only checkpoints whose interval overlaps the window
   (the list step selected artifacts, not checkpoints).
3. Sweep loose ends over EXACTLY the matched artifacts (exact-scope mode —
   do NOT add window flags here; loose ends are current state and the
   combination is rejected):

   ```bash
   orcaops loose-ends --artifact <id> --artifact <id2> --json
   ```
4. Render three sections:
   - **Shipped** — artifacts with a summary or steps completed inside the
     window (cite the summary outcome + completed step labels).
   - **In flight** — open checkpoints and unsummarized artifacts (age from
     `open_checkpoints`).
   - **Loose ends** — step 3's findings: open items, deferred decisions,
     uncertainty (with checkpoint provenance), uncovered steps.

Keep the report scannable: one line per item, artifact labels over ids,
timestamps only where they matter.

# Format: changelog (release notes over a ref range)

```bash
orcaops list --between <ref1>..<ref2> --json   # the changelog feed
orcaops show <id> --json                       # per matched artifact: summary + outcome
```

Two-dot ranges only. `--between` is branch-agnostic (never combine with
`--branch`/`--all-branches` or window flags — rejected). Matching is on
recorded head shas (checkpoint close / summary / pre-pr) ∩
`git rev-list ref1..ref2`; `matched_shas` entries mean "close-time or
summary-time HEAD landed in range", NOT "this checkpoint's own commit".
Run it inside the target repository because the refs are resolved there. The
artifact feed still includes retained archive history for that identified
project.

1. One bullet per `matched` artifact: lead with the LABEL (user-intent
   wording), then the summary outcome from `show --json`. Never paste
   commit subjects — the captured task wording is the product.
2. **MANDATORY disclosure:** if `unmatched_candidates` is non-empty, add a
   "possibly rebased away" note listing them — these artifacts' lineage says
   they belong to the target branch but no recorded sha landed in the range
   (rebases rewrite shas). Silently dropping them is the failure mode this
   bucket exists to prevent.
3. Group bullets by touched_scope tags when the list is long; keep each
   bullet one line, linkable by artifact id.

# Format: journal (dated entry appended to a notes file the user owns)

```bash
orcaops list --all-branches --active-since <ISO> --active-until <ISO> --json
orcaops decisions --all-branches --active-since <ISO> --active-until <ISO> --json
orcaops loose-ends --all-branches --json
```

Same local-window-to-UTC discipline as standup (interval-overlap activity). decisions
FILTERS RECORDS by the window; loose-ends is current-state — its findings
are today's open tab, not the period's history.

APPEND (never rewrite history) to the user's notes file — ask for the path
once if unknown (`NOTES.md` / `docs/journal.md` conventions); create it
only with consent. Entry shape:

```markdown
## <YYYY-MM-DD> — <one-line theme>

### Shipped
- <artifact label>: <summary outcome> (<artifact id>)

### Decided
- <decision> — <reason> (rejected: <alternative>)

### Still open
- <loose end> (<artifact id>)
```

Every bullet cites its artifact id — the journal is a verifiable record, not
a memory. The CLI never writes this file; the agent does, and the user
commits it (that's the point).
