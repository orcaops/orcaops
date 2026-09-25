Read the plan_steps and the files the latest checkpoint changed.

Which files changed:

- `Changed files reported by the agent` is the agent's own `files_changed`
  claim. It can leave files out.
- When the Context block has `Changed files observed by git`, that list is
  what actually changed between this checkpoint's open and close snapshots.
  Judge the observed list, not only the reported one.
- `Observed but NOT reported by the agent` names observed paths missing
  from the reported list. Judge each one like any other changed file, and
  when one drifted from the plan, say in its finding that the agent did not
  report it.
- The observed list covers only this checkpoint's window. A reported file
  that is not in it may have changed outside the window; do not conclude
  it is unchanged.

Decide whether the changed files line up with what the plan said the
agent would touch. Trivial out-of-scope edits (formatting, typo
fixes, removing unused imports, comment changes) are not drift.

**Response format (strict):** write your explanation as prose, then END your
response with a verdict sentinel — a fenced `orcaops-verdict` block whose only
content is `PASS` or `VIOLATION`. Emit exactly one sentinel of your own and
make it the last thing you write; when several appear, the last one is read as
the verdict. Never write a bare `PASS` / `VIOLATION` / `INFO` line in your
prose.

If the changes match the plan, or only trivial drift is present:

<one short sentence noting what you verified>

```orcaops-verdict
PASS
```

Otherwise:

## findings

- `<file>` — one sentence explaining how it drifted from the plan
- `<file>` — ...

```orcaops-verdict
VIOLATION
```

## Optional: structured findings

You MAY also emit ONE `orcaops-findings` block, immediately BEFORE the
sentinel. It is optional — emitting none is always valid — and it never
changes the verdict or whether anything blocks. A block that cannot be read
costs you the findings and nothing else.

Emit one finding per file you judged drifted, so the drift survives outside
this prose. `title` names the file and how it drifted, in one line; `detail`
carries the reasoning.

- `locations`: `{"kind":"file","path":"<path>"}` taken verbatim from
  `Changed files`, plus `{"kind":"plan-step","step_id":"<id>"}` when a listed
  plan step is the one the change drifted away from. Those two kinds only, and
  only ids and paths the Context block above actually shows you — never invent
  one. Omit `revision`: nothing here tells you which commit you are looking at.
- Never set `conclusion`. It says whether an expectation was met, and drift is
  not a judgement about any step's delivery.
- `key`: `drift/<path>` when the finding names exactly one file and that path
  is made only of letters, digits, `.`, `_`, `-` and `/`, so the same file
  drifting again is recognised as the same finding. Otherwise omit `key` — a
  key with characters dropped names a different file.

The block is one JSON object. Shown indented here, which makes it inert — copy
the shape, not this text, and start your own fence at the left margin:

    ```orcaops-findings
    {"schema":"orcaops.evaluator_findings/v1","findings":[{"key":"drift/<path>","title":"<path> is outside what the plan said would be touched","detail":"<how>","locations":[{"kind":"file","path":"<path from Changed files>"}]}]}
    ```
