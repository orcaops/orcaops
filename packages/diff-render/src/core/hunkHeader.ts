// Vendored from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path src/core/hunkHeader.ts
// MIT License, Copyright (c) Ben Vinegar. Full text: packages/diff-render/LICENSE.
// Adaptations for @orcaops/diff-render:
//   none - copied verbatim.

import type { Hunk } from "@pierre/diffs";

/** Format a unified-diff hunk header exactly as Hunk should display it. */
export function formatHunkHeader(hunk: Hunk) {
  const specs =
    hunk.hunkSpecs ??
    `@@ -${hunk.deletionStart},${hunk.deletionLines} +${hunk.additionStart},${hunk.additionLines} @@`;
  return hunk.hunkContext ? `${specs} ${hunk.hunkContext}` : specs;
}
