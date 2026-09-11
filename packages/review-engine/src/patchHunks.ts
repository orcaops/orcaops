export interface PatchHunkLine {
  side: 'add' | 'delete' | 'context';
  /** Old-file line number (deletes + context). */
  old: number | null;
  /** New-file line number (adds + context). */
  new: number | null;
  /** The raw diff line, sign included. */
  raw: string;
  /** The line body without the sign. */
  body: string;
}

export interface PatchHunk {
  file: string;
  oldStart: number;
  newStart: number;
  lines: PatchHunkLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse the pinned unified diff into per-hunk lines, keeping only `files`. */
export function parsePatchHunks(text: string, files: ReadonlySet<string>): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let fileBefore: string | null = null;
  let fileAfter: string | null = null;
  let current: PatchHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  // Inside a hunk every row carries a sign column, so the file-header prefixes
  // describe the SIGNED row rather than its content: a deleted `-- ` line
  // renders as `--- ` and an added `++ ` line as `+++ `. Reading those as
  // headers dropped the row AND everything after it in the same hunk, since the
  // header arms also clear `current` and stop the line counters — so one SQL or
  // Lua comment silently truncated a file's attribution.
  let inHunk = false;

  for (const raw of text.split('\n')) {
    if (inHunk && !continuesHunkBody(raw)) inHunk = false;
    if (!inHunk) {
      if (raw.startsWith('diff --git')) {
        fileBefore = null;
        fileAfter = null;
        current = null;
        continue;
      }
      if (raw.startsWith('--- ')) {
        fileBefore = stripPrefix(raw.slice(4).trim());
        current = null;
        continue;
      }
      if (raw.startsWith('+++ ')) {
        fileAfter = stripPrefix(raw.slice(4).trim());
        current = null;
        continue;
      }
      const header = HUNK_RE.exec(raw);
      if (header === null) {
        current = null;
        continue;
      }
      const file = fileAfter ?? fileBefore;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      if (file !== null && files.has(file)) {
        current = { file, oldStart: oldLine, newStart: newLine, lines: [] };
        hunks.push(current);
      } else {
        current = null;
      }
      continue;
    }
    const kind = raw[0];
    if (kind === '+') {
      current?.lines.push({ side: 'add', old: null, new: newLine, raw, body: raw.slice(1) });
      newLine += 1;
    } else if (kind === '-') {
      current?.lines.push({ side: 'delete', old: oldLine, new: null, raw, body: raw.slice(1) });
      oldLine += 1;
    } else if (kind === ' ') {
      current?.lines.push({ side: 'context', old: oldLine, new: newLine, raw, body: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
    // `\` annotates the row before it and is the only other body line.
  }
  return hunks;
}

/**
 * True while `raw` still belongs to the hunk body that precedes it. Git renders
 * an empty context line as a single space, so a bare newline ends the hunk.
 */
function continuesHunkBody(raw: string): boolean {
  const sign = raw.charAt(0);
  return sign === ' ' || sign === '+' || sign === '-' || sign === '\\';
}
