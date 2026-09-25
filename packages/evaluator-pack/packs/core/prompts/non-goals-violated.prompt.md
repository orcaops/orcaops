Read the plan's `Non-goals` (intentionally out of scope) — listed in
the Context block above — and compare them against the latest
checkpoint's summary and the files it changed.

Which files changed:

- `Changed files reported by the agent` is the agent's own claim. It can
  leave files out.
- When the Context block has `Changed files observed by git`, that list is
  what actually changed between this checkpoint's open and close snapshots.
  Judge the observed list: a non-goal file in it was changed at this
  checkpoint even if the agent did not report it.
- `Observed but NOT reported by the agent` names observed paths missing
  from the reported list. Check each one against the non-goals, and when
  you report a finding on one, say that the agent did not report it.
- The observed list covers only this checkpoint's window. A reported file
  that is not in it may have changed outside the window; do not conclude
  it is unchanged.
- Without an observed list, judge the reported files and the summary, and
  do not treat a file's absence from the reported list as proof it did not
  change.

If no non-goals were captured (the Context block has no Non-goals
section), respond with a single sentence noting that no non-goals were
captured and there is nothing to evaluate, under an `INFO` verdict.

Otherwise, decide whether any change at this checkpoint crosses a
captured non-goal. A change "crosses" a non-goal when its purpose,
mechanism, or effect is what the non-goal said the work would not do.
Trivial co-located edits (formatting, typo fixes, comment changes,
unused-import removal) are not violations.

**Response format (strict):** write your explanation as prose, then END your
response with a verdict sentinel — a fenced `orcaops-verdict` block whose only
content is `PASS`, `VIOLATION`, or `INFO`. Emit exactly one sentinel of your
own and make it the last thing you write; when several appear, the last one is
read as the verdict. Never write a bare `PASS` / `VIOLATION` / `INFO` line in
your prose.

If no change crosses a non-goal:

<one short sentence naming each non-goal you verified the checkpoint
respected>

```orcaops-verdict
PASS
```

If at least one non-goal was crossed:

## findings

- **non-goal:** "<the non-goal verbatim>"
  **crossed by:** `<file or change>` — one sentence on how
- **non-goal:** "<...>"
  **crossed by:** ...

```orcaops-verdict
VIOLATION
```

If no non-goals were captured:

No non-goals captured for this plan; nothing to evaluate.

```orcaops-verdict
INFO
```

## Optional: structured findings

You MAY also emit ONE `orcaops-findings` block, immediately BEFORE the
sentinel. It is optional — emitting none is always valid — and it never
changes the verdict or whether anything blocks. A block that cannot be read
costs you the findings and nothing else.

Emit one finding per non-goal you found crossed, so the crossing survives
outside this prose. `title` names the non-goal and what crossed it, in one
line; `detail` carries the quote and the reasoning.

- `locations`: `{"kind":"file","path":"<path>"}` for each crossing file, taken
  verbatim from `Changed files`, and
  `{"kind":"plan-step","step_id":"<id>"}` when a listed plan step is what
  directs the crossing work. Those two kinds only, and only ids and paths the
  Context block above actually shows you — never invent one. Omit `revision`:
  nothing here tells you which commit you are looking at.
- Never set `conclusion`. It says whether an expectation was met, and a
  crossed non-goal is not a judgement about any step's delivery.
- Omit `key`. A non-goal carries no id here, and a key built out of its prose
  would make a reworded non-goal a different finding.

The block is one JSON object. Shown indented here, which makes it inert — copy
the shape, not this text, and start your own fence at the left margin:

    ```orcaops-findings
    {"schema":"orcaops.evaluator_findings/v1","findings":[{"title":"<non-goal> was crossed by <what>","detail":"<how>","locations":[{"kind":"file","path":"<path from Changed files>"}]}]}
    ```
