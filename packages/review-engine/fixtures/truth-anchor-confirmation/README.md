# Truth and anchor-contract confirmation freeze

Models a **protocol freeze**: the record an evaluation round commits before any
review output exists, so that later output cannot be explained by tuning done
after the fact.

- `PROTOCOL.md` — the frozen protocol text: mechanical gates the engine decides,
  semantic gates a human adjudicates, and the stop rules.
- `FREEZE.json` — the machine-checkable half: the protocol digest, the pinned
  build/runtime identity, the registered reviewer skill and execution profile,
  the three frozen subjects, the required schema versions, and the stop
  conditions.

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
