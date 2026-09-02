This is the demo LLM-engine evaluator. Respond exactly:

Hello from packs/demo's LLM evaluator. The capture context has
already been prepended above. To replace this with your own LLM
evaluator, copy `packs/demo/evaluators/hello-llm.eval.yaml` to your
own pack and edit the prompt body.

```orcaops-verdict
INFO
```

The fenced `orcaops-verdict` block is how every LLM evaluator reports its
verdict: prose above, exactly one sentinel last. `PASS`, `VIOLATION`, and
`INFO` are the three it may contain.
