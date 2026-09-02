# story-ownership-2026-07

A multi-thread ownership-derivation proof for `derivePartOwnership`
(`src/storyOwnership.ts`). `scenario.json` holds **real `attribute()` inputs**,
not pre-baked `CoverageItem[]`: a synthetic chain (via `buildChain`), a
synthetic unified diff, per-line segment owners, and a concurrent-overlap
declaration. The test runs the actual `attribute()` pipeline over these, then
folds the resulting coverage up into Parts. Inputs are git-free and synthetic,
following `packages/review-core/src/attribution/coverage.test.ts` — what matters
is that the real attribution code path produces the coverage the fold consumes.

## Threads and the chain

Three artifacts (`a1`, `a2`, `a3`). Checkpoint refs are `a<i>:cp<n>`. Ordered by
`(closedAt, artifact, n)`, the usable checkpoints and one interleaved gap form
the segment lineage:

| segment | owner                     | note                                                     |
| ------- | ------------------------- | -------------------------------------------------------- |
| 0       | `a1:cp1`                  | checkpoint                                               |
| 1       | `a2:cp1`                  | checkpoint                                               |
| 2       | gap `a2:cp1->a3:cp1.open` | uncaptured window (spans the abandoned `a2:cp2` attempt) |
| 3       | `a3:cp1`                  | checkpoint                                               |
| 4       | `a1:cp2`                  | checkpoint                                               |

`a2:cp2` is **abandoned** → excluded from the chain (chain.ts) → owns zero rows.

## Part topology (authored membership only)

- **P1** (Act I) ← `a1:cp1`
- **P2** (Act I) ← `a2:cp1`
- **P3** (Act II) ← `a1:cp2`, `a3:cp1` — two checkpoints from **different**
  artifacts collapse into one Part; their owned slices must union.

## Per-file design

| file                  | rows | attribution outcome                                                                                |
| --------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `src/alpha.ts`        | +3   | all `a1:cp1` → P1 segment (3 rows)                                                                 |
| `src/beta.ts`         | +2   | all `a2:cp1` → P2 segment (2 rows)                                                                 |
| `src/gamma.ts`        | +4   | run `a3:cp1` (2) + run `a1:cp2` (2), both P3 → **union** (4 rows)                                  |
| `src/gap_area.ts`     | +4   | gap run (2, segment 2) + unowned run (2, no owner) → **unattributed**                              |
| `src/contested.ts`    | +3   | concurrent → `ambiguous_hunk`, candidates `a1:cp1` (P1) + `a2:cp1` (P2) → **cross-Part contested** |
| `src/samepart_amb.ts` | +2   | concurrent → `ambiguous_hunk`, candidates `a1:cp2` + `a3:cp1`, both P3 → **same-Part ambiguity**   |

## Hand-computed goldens

Coverage summary from `attribute()`:

- `matched_rows` = 3 + 2 + 4 = **9**
- `unexplained_rows` (gap + unowned) = **4**
- `ambiguous_rows` = contested 3 + same-Part 2 = **5**
- `reviewable_rows` = **18**; `excluded` = 0; `unreviewable` = 0

`derivePartOwnership`:

- P1: 3 attributed rows, 0 ambiguous
- P2: 2 attributed rows, 0 ambiguous
- P3: 4 attributed rows (2 segments unioned), 2 same-Part ambiguous rows
- contested: 1 entry, 3 rows, `partIds` = [P1, P2]
- unattributed: 4 rows (one gap run + one unowned run)

Metrics:

- `attributedRows` = 9, `attributedPct` = 50
- `ambiguousRows` (same-Part) = 2, `contestedRows` = 3, `unattributedRows` = 4
- `contributingThreads` = 3 (a1, a2, a3)
- `contributingCheckpoints` = 4 (a1:cp1, a2:cp1, a3:cp1, a1:cp2)

Exactly-once: 9 (Parts) + 2 (in-Part ambiguity) + 3 (contested) + 4
(unattributed) = 18 = `reviewable_rows`.
