# Corrected truth and anchor-contract confirmation freeze

The second-round counterpart of `../truth-anchor-confirmation`, modelling what a
protocol freeze looks like **after** an earlier round found deterministic
contract defects: the earlier freeze is never rewritten, a new one is committed
alongside it, and `prior_round` points back at the round it supersedes.

Relative to the first round this freeze adds a compiled-runtime manifest hash to
the pinned runtime identity, a matching `compiled_runtime_manifest_drift` stop
condition, and gates covering only the corrections plus the original
merge-blocking gates.

- `PROTOCOL.md` — the frozen protocol text for the corrected round.
- `FREEZE.json` — the protocol digest, pinned build/runtime identity, registered
  reviewer skill and execution profile, the three frozen subjects, required
  schema versions, and stop conditions.

Every repository, branch, path, subject id, runtime identity, and digest in
`FREEZE.json` is deterministic synthetic data. The generator derives hashes
from a public namespace and field label; it never reads a repository,
transcript, provider response, or machine identity.

`src/confirmationFreeze.test.ts` reads `FREEZE.json` and checks that
`protocol_sha256` is the SHA-256 of `PROTOCOL.md`'s bytes.

## Regenerating

```sh
pnpm --filter @orcaops/review-engine fixtures:generate
pnpm --filter @orcaops/review-engine fixtures:check
```

The generator owns both confirmation `FREEZE.json` files and recomputes each
protocol digest. `src/confirmationFreeze.test.ts` also pins the provenance
namespace, synthetic identity grammar, semantic-anchor profile,
`required_versions`, and subject ids.
