import type { SemanticAnchorSubmissionCatalog } from './semanticAnchorGenerations.js';
import type { SemanticAnchorPreparation } from './semanticAnchors.js';

type PreparedCatalogBlock = {
  alias?: unknown;
  blockKey?: unknown;
  lines?: unknown;
};

type PreparedCatalogLine = {
  ref?: unknown;
  side?: unknown;
  oldLine?: unknown;
  newLine?: unknown;
  lineHash?: unknown;
};

type PreparedCatalogHunk = {
  alias?: unknown;
  hunkKey?: unknown;
  oldFile?: unknown;
  newFile?: unknown;
  displayPath?: unknown;
  blocks?: unknown;
};

/**
 * Narrow adapter from prepared-input v4's richer rename-aware catalog to the
 * submission validator's intentionally small alias/identity/row surface.
 */
export function semanticSubmissionCatalog(
  prepared: SemanticAnchorPreparation
): SemanticAnchorSubmissionCatalog {
  if (prepared.blockCatalog === null)
    throw new Error('READY prepared input has no deterministic change-block catalog');
  const catalog = prepared.blockCatalog as unknown as {
    hunks?: PreparedCatalogHunk[];
  };
  if (!Array.isArray(catalog.hunks))
    throw new Error('prepared change-block catalog has no hunk inventory');
  const blocks = catalog.hunks.flatMap((hunk, hunkIndex) => {
    if (!Array.isArray(hunk.blocks)) return [];
    return (hunk.blocks as PreparedCatalogBlock[]).map((block, blockIndex) => {
      const lines = Array.isArray(block.lines) ? (block.lines as PreparedCatalogLine[]) : [];
      const rows = (side: 'add' | 'delete') =>
        lines
          .filter((line) => line.side === side)
          .map((line) => ({
            ref: String(line.ref ?? ''),
            line: Number(side === 'add' ? line.newLine : line.oldLine),
            line_hash: String(line.lineHash ?? ''),
          }));
      return {
        alias: String(block.alias ?? ''),
        block_key: String(block.blockKey ?? ''),
        hunk_alias: String(hunk.alias ?? ''),
        hunk_key: String(hunk.hunkKey ?? ''),
        old_file: hunk.oldFile === null ? null : String(hunk.oldFile ?? ''),
        new_file: hunk.newFile === null ? null : String(hunk.newFile ?? ''),
        display_file: String(
          hunk.displayPath ??
            hunk.newFile ??
            hunk.oldFile ??
            `change block ${hunkIndex + 1}.${blockIndex + 1}`
        ),
        delete: rows('delete'),
        add: rows('add'),
      };
    });
  });
  return {
    items: prepared.items.map((item) => ({
      alias: item.alias,
      citation_id: item.id,
      citation_kind: item.kind,
    })),
    blocks,
  };
}
