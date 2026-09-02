// diffFileFromPatch — construct a DiffFile from a unified-diff patch string.
//
// Authored by us for @orcaops/diff-render, so it carries a normal header. It
// mirrors the upstream loader's recipe: parse the patch into
// per-file metadata via @pierre/diffs, then wrap the first file's metadata in the
// DiffFile shape the row builders and the highlight hook consume. Unlike the
// upstream loader — which leaves attribution null — this attaches OUR agent
// context so the file's attribution chip has something to render.

import { type FileDiffMetadata, getFiletypeFromFileName, parsePatchFiles } from '@pierre/diffs';

import type { AgentFileContext, DiffFile } from './core/types';

export interface DiffFileFromPatchOptions {
  /** Stable id namespace for the produced DiffFile (id = `${sourceId}:0:<path>`). */
  sourceId: string;
  /** Optional agent attribution surfaced as the file's context chip. */
  agent?: AgentFileContext | null;
}

/** Sum the +/- line counts straight from parsed metadata — no fragile text scan. */
function countStats(hunks: FileDiffMetadata['hunks']): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

/**
 * Parse a unified-diff patch for a single file into a DiffFile.
 *
 * The first parsed file wins (the app builds one DiffFile per patch). The patch
 * is normalized to end in a newline before parsing, since the parser is
 * sensitive to a missing trailing newline on the final line.
 */
export function diffFileFromPatch(patch: string, options: DiffFileFromPatchOptions): DiffFile {
  const { sourceId, agent = null } = options;
  const normalized = patch.endsWith('\n') ? patch : `${patch}\n`;
  const metadata = parsePatchFiles(normalized, sourceId, true).flatMap((entry) => entry.files)[0];
  if (!metadata) {
    throw new Error(`diffFileFromPatch: no file diff parsed from patch (sourceId=${sourceId})`);
  }

  return {
    agent,
    id: `${sourceId}:0:${metadata.name}`,
    // The row builder highlights by `language`, but the renderer tokenizes by a
    // filename-derived language; leaving `language` unset prepares the Shiki
    // highlighter for "text" while the render asks for e.g. "typescript" — a
    // "language not found" throw that silently degrades to no syntax colors.
    // Derive it from the same helper the renderer uses so the two always agree.
    language: getFiletypeFromFileName(metadata.name),
    metadata,
    patch,
    path: metadata.name,
    stats: countStats(metadata.hunks),
  };
}
