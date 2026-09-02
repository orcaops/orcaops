// `review anchor` — mint content anchors and finding keys for a composing
// agent. The narrative's code anchors need blake3 line hashes and
// the owning floor hunkKey, and its findings need a regeneration-stable
// findingKey; computing those by hand (or with ad-hoc scripts) is fragile, so
// the sidecar owns it:
//
//   review anchor --branch <b> --file <f> --side <add|delete> --start <n> [--end <n>]
//       → {file, side, startLine, endLine, lineHashes, hunkKey}
//         (a ready-to-paste narrative codeAnchor; hashes cover every CHANGED
//          line of that side in the range, read from the cached diff.patch)
//
//   review anchor --branch <b> --finding <kind>:<scope>:<origin> --ref <id> [--ref <id> …]
//       → {findingKey}
//         (the stable identity dispositions attach to; refs are the anchor
//          id set — hunkKeys and/or citation ids)
//
//   review anchor --branch <b> --hunk <hunkKey>
//       → the same shape, with the anchor LINE AUTO-PICKED: the hunk's first
//         non-trivial changed line (adds preferred). No hand-counting of
//         line numbers in diff.patch.
//
//   Combinable: pass line flags (or --hunk) AND --finding; the resolved
//   hunkKey joins the refs automatically.
//
//   exit 0  anchor emitted
//   exit 1  usage / precondition error (no cached diff, no changed lines in
//           range, bad enum, missing flags)

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FINDING_KIND,
  FINDING_ORIGIN,
  FINDING_SCOPE,
  findingKey,
  type Floor,
  floorSchema,
  isTrivialAnchorBody,
  lineHash,
  slugifyBranch,
} from '@orcaops/review-core';

import { parsePatchHunks, type PatchHunk, positionKey } from './comments.js';
import type { ReviewArgs } from './run.js';

const encoder = new TextEncoder();

const USAGE = `usage: review anchor --branch <b> [line flags] [--finding <spec> --ref <id> …]
  line flags (explicit range):   --file <f> --side <add|delete> --start <n> [--end <n>]
  line flags (auto-pick):        --hunk <hunkKey>   (first non-trivial changed line)
  finding key:                   --finding <kind>:<scope>:<origin> [--ref <id> …]
                                 (a resolved hunkKey joins the refs automatically)
  Emits a ready-to-paste narrative codeAnchor and/or a stable findingKey.
`;

interface AnchorOutput {
  file?: string;
  side?: 'add' | 'delete';
  startLine?: number;
  endLine?: number;
  lineHashes?: string[];
  hunkKey?: string | null;
  findingKey?: string;
}

function fail(message: string): number {
  process.stderr.write(`review anchor: ${message}\n${USAGE}`);
  return 1;
}

function inEnum(value: string, allowed: Record<string, string>): boolean {
  return Object.values(allowed).includes(value);
}

/** Load + position-index the cached floor's coverage, or null when absent. */
async function loadFloorIndex(
  dir: string
): Promise<{ byPosition: Map<string, string>; byHunkKey: Map<string, { file: string }> } | null> {
  try {
    const floor: Floor = floorSchema.parse(
      JSON.parse(await readFile(path.join(dir, 'floor.json'), 'utf8'))
    );
    const byPosition = new Map<string, string>();
    const byHunkKey = new Map<string, { file: string }>();
    for (const item of floor.coverage.items) {
      byPosition.set(
        positionKey(item.file, item.new_start ?? null, item.old_start ?? null),
        item.hunkKey
      );
      byHunkKey.set(item.hunkKey, { file: item.file });
    }
    return { byPosition, byHunkKey };
  } catch {
    return null;
  }
}

/** The patch hunk carrying a floor hunkKey, position-matched like the TUI does. */
function patchHunkFor(
  hunks: readonly PatchHunk[],
  byPosition: Map<string, string>,
  hunkKey: string
): PatchHunk | null {
  for (const hunk of hunks) {
    const key =
      byPosition.get(positionKey(hunk.file, hunk.newStart, hunk.oldStart)) ??
      byPosition.get(positionKey(hunk.file, hunk.newStart, null));
    if (key === hunkKey) return hunk;
  }
  return null;
}

/** Run `review anchor`. Returns the process exit code. */
export async function runAnchor(args: ReviewArgs, root: string): Promise<number> {
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.branch) return fail('--branch <branch> is required');
  const wantsPick = args.hunk !== undefined;
  const wantsLines =
    wantsPick || args.file !== undefined || args.side !== undefined || args.start !== undefined;
  const wantsKey = args.finding !== undefined;
  if (!wantsLines && !wantsKey) {
    return fail('nothing to do — pass --hunk, --file/--side/--start, and/or --finding');
  }

  const out: AnchorOutput = {};
  const refs: string[] = [...(args.refs ?? [])];
  const dir = path.join(root, '.orcaops', 'reviews', slugifyBranch(args.branch));

  // --hunk: auto-pick the anchor line — the hunk's first non-trivial changed
  // line (adds preferred over deletes, matching the TUI's comment anchoring).
  if (wantsPick) {
    if (args.file !== undefined || args.start !== undefined) {
      return fail('--hunk auto-picks the line — do not combine with --file/--start');
    }
    const index = await loadFloorIndex(dir);
    if (index === null) {
      return fail(
        `no valid cached floor at ${path.join(dir, 'floor.json')} — run \`review data --branch <b>\` first`
      );
    }
    const item = index.byHunkKey.get(args.hunk!);
    if (item === undefined) {
      return fail(`hunkKey '${args.hunk!}' is not in the floor coverage table`);
    }
    let diffText: string;
    try {
      diffText = await readFile(path.join(dir, 'diff.patch'), 'utf8');
    } catch {
      return fail(
        `no cached diff at ${path.join(dir, 'diff.patch')} — run \`review data --branch <b>\` first`
      );
    }
    const carrier = patchHunkFor(
      parsePatchHunks(diffText, new Set([item.file])),
      index.byPosition,
      args.hunk!
    );
    if (carrier === null) {
      return fail(`hunkKey '${args.hunk!}' did not position-match the cached diff`);
    }
    const changed = carrier.lines.filter((l) => l.side !== 'context');
    const adds = changed.filter((l) => l.side === 'add');
    const pick =
      adds.find((l) => !isTrivialAnchorBody(l.body)) ??
      changed.find((l) => !isTrivialAnchorBody(l.body)) ??
      changed[0];
    if (pick === undefined) {
      return fail(`hunk '${args.hunk!}' has no changed lines to anchor (rename/binary)`);
    }
    const side = pick.side as 'add' | 'delete';
    const line = (side === 'add' ? pick.new : pick.old)!;
    out.file = item.file;
    out.side = side;
    out.startLine = line;
    out.endLine = line;
    out.lineHashes = [await lineHash(side, encoder.encode(pick.body))];
    out.hunkKey = args.hunk!;
    refs.push(args.hunk!);
  } else if (wantsLines) {
    if (args.file === undefined || args.side === undefined || args.start === undefined) {
      return fail('line anchors need all of --file, --side, --start (or use --hunk)');
    }
    if (args.side !== 'add' && args.side !== 'delete') {
      return fail(`--side must be 'add' or 'delete', got '${args.side}'`);
    }
    const start = Number(args.start);
    const end = args.end !== undefined ? Number(args.end) : start;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
      return fail('--start/--end must be positive integers with end >= start');
    }

    let diffText: string;
    try {
      diffText = await readFile(path.join(dir, 'diff.patch'), 'utf8');
    } catch {
      return fail(
        `no cached diff at ${path.join(dir, 'diff.patch')} — run \`review data --branch <b>\` first`
      );
    }
    const hunks = parsePatchHunks(diffText, new Set([args.file]));
    const side = args.side;
    // Every CHANGED line of the requested side inside [start, end], with the
    // patch hunk that carries the first of them (→ the floor hunkKey).
    const picked: { body: string; hunk: (typeof hunks)[number] }[] = [];
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.side !== side) continue;
        const n = side === 'add' ? line.new : line.old;
        if (n !== null && n >= start && n <= end) picked.push({ body: line.body, hunk });
      }
    }
    if (picked.length === 0) {
      return fail(
        `no changed '${side}' lines in ${args.file}:${start}-${end} of the cached diff — ` +
          'read the printed line numbers from diff.patch (new-file numbers for add, old-file for delete)'
      );
    }

    out.file = args.file;
    out.side = side;
    out.startLine = start;
    out.endLine = end;
    out.lineHashes = [];
    for (const p of picked) out.lineHashes.push(await lineHash(side, encoder.encode(p.body)));

    // Resolve the floor hunkKey by position-matching the carrying patch hunk.
    // No valid floor cached → the anchor still stands, keyless.
    out.hunkKey = null;
    const index = await loadFloorIndex(dir);
    if (index !== null) {
      const carrier = picked[0]!.hunk;
      out.hunkKey =
        index.byPosition.get(positionKey(carrier.file, carrier.newStart, carrier.oldStart)) ??
        index.byPosition.get(positionKey(carrier.file, carrier.newStart, null)) ??
        null;
    }
    if (out.hunkKey !== null && out.hunkKey !== undefined) refs.push(out.hunkKey);
  }

  if (wantsKey) {
    const parts = (args.finding ?? '').split(':');
    if (parts.length !== 3) {
      return fail(
        "--finding must be '<kind>:<scope>:<origin>', e.g. 'VERIFICATION_GAP:CODE:LLM_NATIVE'"
      );
    }
    const [kind, scope, origin] = parts as [string, string, string];
    if (!inEnum(kind, FINDING_KIND)) {
      return fail(
        `unknown finding kind '${kind}' (one of ${Object.values(FINDING_KIND).join(', ')})`
      );
    }
    if (!inEnum(scope, FINDING_SCOPE)) {
      return fail(
        `unknown finding scope '${scope}' (one of ${Object.values(FINDING_SCOPE).join(', ')})`
      );
    }
    if (!inEnum(origin, FINDING_ORIGIN)) {
      return fail(
        `unknown finding origin '${origin}' (one of ${Object.values(FINDING_ORIGIN).join(', ')})`
      );
    }
    if (refs.length === 0) {
      return fail('a finding key needs at least one anchor ref (--ref, or a resolved hunkKey)');
    }
    out.findingKey = await findingKey({
      kind: kind as (typeof FINDING_KIND)[keyof typeof FINDING_KIND],
      scope: scope as (typeof FINDING_SCOPE)[keyof typeof FINDING_SCOPE],
      origin: origin as (typeof FINDING_ORIGIN)[keyof typeof FINDING_ORIGIN],
      anchors: refs,
    });
  }

  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}
