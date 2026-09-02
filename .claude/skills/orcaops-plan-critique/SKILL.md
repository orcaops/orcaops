---
name: "Orcaops: plan critique"
description: "Critique a plan against captured history BEFORE work starts — \"critique this plan\", \"review my plan draft\", \"poke holes in this plan before I start\", \"have we solved something like this before?\", \"what did we decide last time we touched auth?\" — and as a pre-step before `capture plan` on non-trivial work. Two paths: a prior-art sweep feeding the capture (decisions, rejected alternatives, non-goals, unresolved uncertainty from captured artifacts — every archived project when the archive is enabled), and a draft critique against past decisions, fragile files, abandoned attempts, and weak acceptance criteria. Skip for: continuing an in-flight task (resume skill)."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "e53ab500af33"
tags: ["orcaops", "insight"]
---

# When to use

Triggers:

- As a PRE-STEP before `orcaops capture plan` on any non-trivial task
  (the capture skill references this sweep).
- "critique this plan", "review my plan draft", "poke holes in this
  plan before I start".
- "have we solved something like this before?" / "what did we decide
  last time we touched X?"

Skip when:

- The user is continuing an in-flight task → `orcaops-resume`.
- Reviewing SHIPPED work rather than a plan → `orcaops-adversarial-review`.

Both paths drive ONLY existing read commands — `search`, `decisions`,
`loose-ends`, `list --touching`, `show`. Nothing here writes.

Artifacts with `origin.kind: git-import` are synthesized prior art. Label every
one `[imported]`; use imported decisions only as evidence-cited paraphrases
and include the citation. Never imply that synthesized prose was captured live,
and attribute imported work to its commit authors rather than the current user
or agent.

# Path 1 — prior-art sweep (feeds a new capture)

Pick 2-4 content terms from the task (feature nouns, subsystem names,
error strings) and sweep captured history:

```bash
orcaops search "<term>" --json
orcaops decisions --json                    # decision records with rationale
```

**Cross-project mode:** when the archive is enabled
(`archive.enabled: true`), add `--all-projects` to BOTH commands to
sweep every archived project on this machine, not just this repo —
each hit carries a `project` field; cite it. From inside a repo or linked
worktree, the current project includes hot and retained archive history,
deduplicated by artifact ID with archive selected only when strictly newer
(ties use hot). Without the archive the same sweep runs current-repo-only —
say so and proceed; never block planning on missing history. `orcaops show`
remains current-repository-only, so use cross-project `decisions` and
`loose-ends` for detail from other projects.

What to inject into the new plan, from matching artifacts:

1. **Decisions with rejected alternatives** — the strongest signal: if a
   prior artifact rejected an approach with a reason, carry that into the
   new plan's `decisions[]` (as prior art) instead of re-litigating.
2. **Non-goals** — recurring exclusions usually still apply; propose them
   for the new plan's `non_goals`.
3. **Unresolved uncertainty** — a prior artifact's open uncertainty on the
   same scope is a risk the new plan should address or explicitly inherit.

Keep it to the 3-5 most relevant precedents; link each as
`<artifact_id>` (`<project>/<artifact_id>` cross-project). Then proceed
to `orcaops-capture`.

# Path 2 — draft critique (a plan already exists)

Read the draft, then interrogate it against captured history — one pass
per lens, citations required:

1. **Contradicted decisions.** `orcaops decisions --json` (add
   `--all-projects` when the archive is enabled): does any step reverse
   a recorded decision without saying why it no longer holds? Flag it —
   the fix is a new decision acknowledging the reversal, not silence.
2. **Fragile files.** For each file/subsystem the draft touches:
   `orcaops list --touching <path> --json` → artifacts that repeatedly
   touched it; `orcaops show <id> --json` for their uncertainty and
   evaluator violations. A file with recurring uncertainty or violations
   deserves an explicit risk line in the plan.
3. **Abandoned attempts.** Prior artifacts on the same scope with
   abandoned checkpoints or no summary — `orcaops search "<term>" --json`
   then `show` — are attempts that DIED. Ask what killed them; the plan
   should say why this time is different.
4. **Non-goal drift.** Compare the draft against recurring `non_goals`
   in prior artifacts; a plan quietly re-including a recurring exclusion
   needs the exclusion's rationale addressed.
5. **Weak acceptance criteria.** `orcaops loose-ends --json` shows what
   past plans left dangling. Steps whose criteria are vague ("works",
   "is clean") or missing produce exactly those dangles — propose
   concrete, checkable criteria.

Deliver the critique as findings with citations (artifact id +
checkpoint/decision), each with a proposed plan edit. No citation → no
finding; history-free style opinions belong in code review, not here.
