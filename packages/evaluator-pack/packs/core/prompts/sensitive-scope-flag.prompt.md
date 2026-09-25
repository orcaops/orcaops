The plan touches a sensitive scope. Read the plan steps and any
captured checkpoints. Verify all three of the following are
explicitly addressed in either the plan_steps or checkpoint
summaries:

1. **Idempotency** — what happens if this runs twice?
2. **Rollback** — how is this safely reversed if it goes wrong?
3. **Test coverage** — are tests for the sensitive code paths included?

**Response format (strict):** write your explanation as prose, then END your
response with a verdict sentinel — a fenced `orcaops-verdict` block whose only
content is `PASS` or `VIOLATION`. Emit exactly one sentinel of your own and
make it the last thing you write; when several appear, the last one is read as
the verdict. Never write a bare `PASS` / `VIOLATION` / `INFO` line in your
prose.

If all three concerns are addressed:

<one short sentence noting what you verified>

```orcaops-verdict
PASS
```

If any are missing:

## findings

- **Idempotency** — explanation of what's missing or unclear
- **Rollback** — ...
- **Test coverage** — ...

```orcaops-verdict
VIOLATION
```

## Optional: structured findings

You MAY also emit ONE `orcaops-findings` block, immediately BEFORE the
sentinel. It is optional — emitting none is always valid — and it never
changes the verdict or whether anything blocks. A block that cannot be read
costs you the findings and nothing else.

Emit one finding per concern you found unaddressed, so it survives outside
this prose. `title` names the concern and what is missing, in one line;
`detail` says where you looked.

- `locations`: `{"kind":"plan-step","step_id":"<id>"}` for the listed step
  that would have to address the concern, when one step clearly owns it. That
  kind only, taking ids from `Plan steps` above and never inventing one; leave
  `locations` out when no single step owns the concern.
- Never set `conclusion`. It says whether an expectation was met, and an
  unaddressed concern is not a judgement about a step's delivery — this check
  fires before the work exists.
- `key`: exactly `idempotency`, `rollback` or `test-coverage`, one per finding.
  These three are fixed, so the same gap on a later run is recognised as the
  same finding.

The block is one JSON object. Shown indented here, which makes it inert — copy
the shape, not this text, and start your own fence at the left margin:

    ```orcaops-findings
    {"schema":"orcaops.evaluator_findings/v1","findings":[{"key":"rollback","title":"No step says how this is reversed","detail":"<where you looked>","locations":[{"kind":"plan-step","step_id":"<id from Plan steps>"}]}]}
    ```
