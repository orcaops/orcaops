Read the plan_steps and the latest checkpoint's `files_changed`.

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
