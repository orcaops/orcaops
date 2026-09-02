Read the plan's `Non-goals` (intentionally out of scope) — listed in
the Context block above — and compare them against the latest
checkpoint's summary plus `Changed files`.

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
