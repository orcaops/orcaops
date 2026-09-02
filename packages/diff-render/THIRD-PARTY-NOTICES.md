# Third-party notices

This package contains and depends on third-party software.

## Vendored source (copied into `src/**`)

### hunk (`hunkdiff`)

- Source: <https://github.com/modem-dev/hunk> @ commit `9ef9b2e`
- License: **MIT**, Copyright (c) Ben Vinegar
- Full license text: [`LICENSE`](./LICENSE) (this package's `LICENSE` is hunk's,
  reproduced as the MIT terms require).
- Scope: **24 vendored files** (14 copied verbatim, 10 adapted) — the diff
  render-row layer, highlighted-diff/source hooks, multi-line input primitives
  (keyboard predicates, `$EDITOR` round-trip, textarea composer),
  windowed-mounting layer (row windowing, file render window + section layout,
  adaptive scroll overscan), and bounded terminal-text sanitizer under
  `src/ui`, `src/core`, `src/lib`. Per-file headers name each file's source path
  and disclose any adaptation (`grep -rl 'Vendored from hunk' src` is the
  authoritative set).
- Not covered here: `src/ui/diff/_boundary.ts`,
  `src/ui/diff/fileSlottedBoundedCache.ts`, `src/ui/diff/focusMask.ts`,
  `src/ui/diff/frameStyling.ts`, `src/ui/diff/highlightedDiffCache.ts`,
  `src/ui/diff/sliceGeometry.ts`,
  `src/fromPatch.ts`, `src/index.ts`, the `*.test.ts` files, and
  `src/test/opentuiCoreStub.ts` are **orcaops-authored**, not vendored (they
  carry no MIT provenance header). See the README's provenance section.

## Runtime dependencies (installed from npm, not vendored)

### @pierre/diffs

- License: **Apache-2.0**
- Role: diff model + Shiki-WASM syntax highlighter engine (`FileDiffMetadata`,
  `Hunk`, `FileContents`, and the render/highlight functions the vendored
  `pierre.ts` wraps).
- Note: Apache-2.0 is a permissive license; it carries a patent grant and a
  NOTICE-propagation term but imposes no copyleft on this package or the product.
  It pulls a transitive tree (Shiki, `diff`, `@pierre/theme`, `@pierre/theming`,
  `hast-util-to-html`, `@shikijs/transformers`) resolved by the workspace.

### string-width

- License: **MIT**
- Role: terminal display-width measurement for row layout.

## Peer dependencies

`@opentui/core`, `@opentui/react`, and `react` are provided by the consuming
application; they are not bundled or redistributed by this package.
