import path from 'node:path';

import {
  ORCAOPS_AGENTS_MD_MARKER_END,
  ORCAOPS_AGENTS_MD_MARKER_START_RE,
  ORCAOPS_BLOCK_ROUTING_SENTINEL,
} from '@orcaops/adapters';

import { readContainedRepositoryRegularFileOrNull } from './mutations.js';

/**
 * Never throws; each caller wants its own safe action. Follows an in-repo
 * symlink but never OPENS a non-regular entry — a writerless FIFO would block a
 * libuv threadpool thread and hang the hook.
 */
export async function readInstructionBlock(repoRoot: string, rel: string): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await readContainedRepositoryRegularFileOrNull(
      path.join(repoRoot, rel),
      repoRoot,
      `instruction block ${rel}`
    );
  } catch {
    return null;
  }
  if (raw === null) return null;
  const start = raw.match(ORCAOPS_AGENTS_MD_MARKER_START_RE);
  if (start?.index === undefined) return null;
  const end = raw.indexOf(ORCAOPS_AGENTS_MD_MARKER_END, start.index);
  if (end === -1) return null;
  return raw.slice(start.index, end + ORCAOPS_AGENTS_MD_MARKER_END.length);
}

/**
 * The sentinel, not the marker: blocks generated while the read-intent section
 * was trimmed carry a marker and no routing.
 */
export async function instructionFileCarriesRouting(
  repoRoot: string,
  rel: string
): Promise<boolean> {
  const region = await readInstructionBlock(repoRoot, rel);
  return region !== null && region.includes(ORCAOPS_BLOCK_ROUTING_SENTINEL);
}
