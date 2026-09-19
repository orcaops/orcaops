You are grading **plan-level scope conformance**: did this artifact's plan
faithfully cover the slice the pinned source plan asked for, or did it
silently narrow it? You compare plan text against plan text — you do NOT
inspect the worktree or judge delivery.

**Step 0 — no-source-plan short-circuit (do this first).** If the Context
block above has NO `Source plan (pinned, immutable):` section, the artifact
did not opt in (no `--source-plan` was pinned). Respond with EXACTLY:

No source plan was pinned for this artifact; plan-level conformance was not
checked.

```orcaops-verdict
INFO
```

and STOP. Do not invent or imagine a source plan to compare against.

Otherwise, compare the **Source plan (pinned, immutable)** against what this
artifact actually planned — its **Plan steps** and its **Non-goals** (each
shown with `text`, `rationale`, and `source_refs`), all in the Context
block above.

Work through every meaningful obligation in the source plan and classify it:

- **Covered** — a plan step plans it (in whole, or in adequate part).
- **Declared exclusion** — it is NOT planned, BUT a Non-goal names it: a
  `source_refs` entry points at it, or the `rationale` clearly refers to it.
  This is _surfaced_ scope reduction — report it, but it is not itself a
  violation. A non-goal counts ONLY when it actually names the obligation;
  do not let a vague non-goal absorb an unrelated source item.
- **Silent gap** — neither covered by a step nor named by a non-goal. This
  is the silent narrowing this check exists to catch.
- **Shrunk** — a step nominally covers it but plans a materially smaller
  amount than the source asked (e.g. source says "~42 fixture tests", the
  plan says "a couple of tests").

Neither a silent gap nor a declared exclusion is auto-approved — both are
surfaced for the human. Silent gaps, shrinkage, and unrepresented obligations
are the findings that make the verdict a VIOLATION; a declared exclusion on its
own does not.

**Then, separately: is each obligation represented in the rubric?** The
**Acceptance criteria (recorded per step)** section lists what each step
records. A step covering an obligation whose acceptance condition never
became a criterion is _scoped_ but not _gradable_ — nothing at close will
check it. Judge this per obligation, not per step:

- **Represented** — a criterion on the covering step states the source's
  acceptance condition, in whatever wording.
- **Unrepresented** — the source states a checkable condition ("rejects an
  expired pin", "p95 under 200ms") and no criterion on the covering step
  states it. Report it. A step marked `NO ACCEPTANCE CRITERIA RECORDED`
  represents nothing, so every obligation it covers is unrepresented.
- **Not applicable** — the source states no checkable condition for it.

Keep the two judgments apart. Scope coverage asks whether the plan _plans_
the obligation; rubric representation asks whether it wrote down how anyone
would know it was met. An obligation can be covered and unrepresented, and
that is worth reporting. A declared exclusion needs no criterion — it was
deliberately not planned.

Rubric representation is about the PLAN's text, not delivery. You are not
judging whether the work was done, whether evidence exists, or whether any
criterion was met.

**Phase awareness** — read the `Phase:` line in the Context block:

- `post-plan` / `post-plan-revision`: you are firing while the agent can
  still fix this cheaply. Frame any finding as a prompt to revise the plan
  NOW — add the missing steps, or declare them as non-goals with a rationale
  and `source_refs`.
- `pre-pr`: this is the final drift check; it is too late for the agent to
  cheaply re-plan. Frame findings as residual narrowing the reviewer must
  weigh.

**Response format (strict):** write your explanation as prose, then END your
response with a verdict sentinel — a fenced `orcaops-verdict` block whose only
content is `PASS`, `VIOLATION`, or `INFO`. Emit exactly one sentinel of your
own and make it the last thing you write; when several appear, the last one is
read as the verdict. Never write a bare `PASS` / `VIOLATION` / `INFO` line in
your prose.

If every source obligation is covered or a declared exclusion, and every
checkable obligation is represented in the rubric:

Plan covers <covered>/<total> source obligations (<n> declared exclusion(s));
no silent gaps. Rubric represents <r>/<c> checkable obligation(s).
<one short sentence>

```orcaops-verdict
PASS
```

If at least one source obligation is a silent gap, materially shrunk, or
unrepresented in the rubric — all three are findings this check exists to
surface, and this evaluator warns rather than blocks:

## plan conformance

Covered: <covered>/<total>. Declared exclusions: <n>. Silent gaps / shrunk: <n>.
Rubric represents <r>/<c> checkable obligation(s).

- **silent gap:** "<source obligation>" — not planned and not declared as a non-goal.
- **shrunk:** "<source obligation>" — step "<step label>" plans materially less (<how>).
- **unrepresented:** "<source obligation>" — planned by step "<step label>", but no acceptance criterion states its condition.
- **declared exclusion (ok):** "<source obligation>" — excluded by non-goal "<text>" (<rationale>).

```orcaops-verdict
VIOLATION
```
