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
