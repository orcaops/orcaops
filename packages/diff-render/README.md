# @orcaops/diff-render

An **isolated, third-party-derived** package: the per-hunk diff render + row
layer for the Task Review TUI. It exists as its own package precisely so the
vendored MIT source stays quarantined from our own code — the rest of the repo
(`@orcaops/review-core`, the watch app, the skill) imports **only** this
package's public API (`src/index.ts`) and carries none of the vendored
identifiers.

## Provenance

The `src/**` render/row layer is **vendored** (copied, with disclosed
adaptations) from **hunk**:

- Source: <https://github.com/modem-dev/hunk> (`hunkdiff`)
- Commit: `9ef9b2e` (v0.16.0 + 20)
- License: **MIT**, Copyright (c) Ben Vinegar — see [`LICENSE`](./LICENSE)

Every vendored file carries a header naming its exact source path within that
repo and listing any adaptation made to it. Files are otherwise copied
verbatim. The vendored set (24 files) is the transitive closure of the two
entry modules `src/ui/diff/pierre.ts` and `src/ui/diff/renderRows.tsx`, plus the
`useHighlightedDiff` and `useHighlightedSource` hooks, the theme subtree that supplies concrete
`AppTheme` instances, the input primitives (`ui/lib/keyboard.ts`,
`ui/lib/openInEditor.ts`, `ui/components/composer.tsx`) behind the multi-line
composer, and the windowed-mounting layer (`ui/diff/rowWindowing.ts`,
`ui/lib/fileRenderWindow.ts` with its `ui/lib/fileSectionLayout.ts` layout
types, `ui/lib/adaptiveScrollOverscan.ts`).

Vendoring a set that large is deliberate: large-file virtualization
(`rowWindowing` / `fileRenderWindow` / `fileSectionLayout` /
`adaptiveScrollOverscan`) and gap expansion (`useHighlightedSource`) each need
real hunk machinery that a thinner render written directly over `@pierre/diffs`
would have had to reproduce anyway. `index.ts` stays the single seam that would
absorb a future re-vendor.

### Adaptations from source

Ten files are adapted; the other fourteen are copied verbatim. Each adapted
file's own header states the same adaptation in place; this list is the summary.

- **`ui/diff/renderRows.tsx`** — the `PlannedReviewRow`, `inlineNoteTitle`, and
  `CopySelectedRowRange` imports (from source modules we do not vendor)
  retargeted to the local [`src/ui/diff/_boundary.ts`](./src/ui/diff/_boundary.ts)
  severance shim. That shim is **our** code, not vendored; it provides the minimal
  faithful surface `renderRows.tsx` reads. The boundary is **permanent**: pins
  ship through DiffSlice's slot seams rather than the upstream
  review-render-plan splice loop, so the shim is a stand-in that never gets
  replaced — not a transitional stub. It also accepts Orcaops' orthogonal
  `DiffRowFocus` metadata, preserving canonical syntax spans while rendering
  subdued cells with neutral surfaces, softened word-diff emphasis, and a
  width-stable segmented rail.
- **`ui/diff/rowStyle.ts`** — adds the focus-aware neutral palettes, softened
  word-diff background selection, and one-cell segmented rail used by
  `renderRows.tsx`; canonical row semantics and geometry stay unchanged.
- **`core/types.ts`** — the `FileSourceFetcher` import (from the Bun-runtime
  `fileSource` module) inlined as its extracted provider-neutral interface,
  keeping this package free of Bun / `fs` coupling.
- **`ui/components/composer.tsx`** — the draft-note textarea composer core
  extracted from `src/ui/components/panes/AgentInlineNote.tsx` as the reusable
  `TextComposer` (plain props instead of the annotation model; `^E` editor
  hand-off added); the annotation-thread rendering and hand-drawn card chrome
  are not vendored.
- **`ui/lib/openInEditor.ts`** — `Bun.spawnSync` → `node:child_process`
  `spawnSync`, and the file-opening helper replaced by `editTextViaEditor`, a
  temp-buffer round-trip for composer input; the command splitter is replaced
  by a bounded single-pass tokenizer.
- **`ui/diff/rowWindowing.ts`** — the `DiffSectionGeometry` / `PlannedReviewRow`
  type imports (from the un-vendored `diffSectionGeometry` / `reviewRenderPlan`
  modules; the latter is permanently off-limits per `_boundary.ts`) replaced by
  the minimal structural stand-ins `WindowedSectionGeometry` and a `Row` type
  parameter; the function bodies are verbatim.
- **`ui/diff/pierre.ts`** — parsed-patch highlighting scheduled at hunk grain so
  navigation can paint between Shiki jobs.
- **`ui/diff/useHighlightedDiff.ts`** — weight-bounded shared caching plus
  hunk-scoped loading for mounted parsed-patch slices.
- **`ui/lib/fileRenderWindow.ts`** — half-open viewport intersections so
  exact-edge sections remain offscreen.
- **`lib/terminalText.ts`** — bounded resource use on adversarial terminal
  control sequences: the OSC/DCS control-string spans are capped
  (`MAX_CONTROL_SEQUENCE_LENGTH` / `SEQUENCE_SCAN_LIMIT`) so unterminated
  intros cannot trigger quadratic rescans, while the linear stripping passes
  still remove every non-preserved control character past the limit
  (`preserveNewlines` / `preserveTabs` are respected throughout).

### Orcaops-authored source (not vendored)

A handful of `src/**` modules carry a normal header (no MIT provenance line)
because they are **ours**, not copied from hunk — they must not be counted in
the vendored set:

- **`src/ui/diff/_boundary.ts`** — the severance shim the vendored `renderRows`
  and `rowWindowing` retarget onto: faithful minimal stand-ins for the
  un-vendored review-render-plan / copy-selection / inline-note surface. The
  boundary is **permanent**, so this is a lasting seam, not a placeholder for a
  future vendor.
- **`src/ui/diff/sliceGeometry.ts`** — measured per-hunk row bounds for
  scroll-follow and windowed mounting. It mirrors the _idea_ of hunk's
  `diffSectionGeometry.ts` (a `WeakMap` keyed on the immutable `DiffFile`) but is
  written against our `DiffSlice`, not copied.
- **`src/ui/diff/focusMask.ts`** — compiles a checkpoint's owned line ranges
  into orthogonal per-cell focus metadata. It never clones or rewrites the
  canonical diff rows, move markers, signs, or syntax spans.
- **`src/ui/diff/frameStyling.ts`** — frame-level styling probes (distinct
  code-cell foreground counts) used to verify that syntax highlighting actually
  landed in a rendered frame.
- **`src/ui/diff/fileSlottedBoundedCache.ts`** — a slot-keyed, bounded cache
  for derived per-`DiffFile` values held behind `WeakRef`s, so retained frames
  never pin file objects.
- **`src/ui/diff/highlightedDiffCache.ts`** — the bounded highlighted-code
  cache budgets (entry/weight caps sized so nearby file revisits stay warm
  without making a large review permanent).
- **`src/fromPatch.ts`** — builds a `DiffFile` from a unified-diff patch string,
  attaching **our** agent attribution (the upstream loader leaves it null).
- **`src/index.ts`** — the package's public API seam (the only module the app
  imports).

Their `*.test.ts` siblings and `src/test/opentuiCoreStub.ts` are ours too.

## Third-party runtime dependencies

- **`@pierre/diffs`** — the diff-model + Shiki highlighter engine. **Apache-2.0**
  (dependency, not vendored). See [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
- **`string-width`** — terminal cell-width measurement. MIT.

`@opentui/core`, `@opentui/react`, and `react` are **peer** dependencies so the
consuming app supplies one shared instance of each at runtime.

## Consumption

This is a **source-only** package: `exports` points at `src/index.ts` and the
watch app's Bun bundler compiles the TSX directly (no `dist` build). Typecheck
with `pnpm --filter @orcaops/diff-render typecheck`.
