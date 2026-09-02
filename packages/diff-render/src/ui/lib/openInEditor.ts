// Vendored from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path src/ui/lib/openInEditor.ts
// MIT License, Copyright (c) Ben Vinegar. Full text: packages/diff-render/LICENSE.
// Adaptations for @orcaops/diff-render:
//   - Bun.spawnSync -> node:child_process spawnSync (runs under both Bun and Node).
//   - the upstream openSelectedFileInEditor/selectedLine open an EXISTING repo file
//     (DiffFile-coupled); they are replaced by editTextViaEditor, a temp-buffer
//     round-trip for composer input: write the draft to a temp file, open $EDITOR
//     on it (suspending the TUI for terminal editors), read the result back —
//     and by openFileInEditor, the upstream file-at-line open with the DiffFile
//     coupling removed (the caller resolves file + line; per-editor `+LINE` /
//     `--goto file:LINE` args and the suspend-for-terminal-editors semantics
//     are ported as-is).
//   - resolveEditableFilePath dropped; command parsing is bounded and
//     single-pass so a hostile $EDITOR cannot stall the process, with refusal
//     details exposed on EditorCommand.error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";

export interface EditorCommand {
  command: string;
  args: string[];
  /** Present when the editor value cannot produce a launchable command. */
  error?: string;
}

const MAX_EDITOR_COMMAND_LENGTH = 1024;

type EditorTokens =
  | { tokens: string[]; error: null }
  | { tokens: []; error: string };

function splitEditorCommand(editor: string): EditorTokens {
  if (editor.length > MAX_EDITOR_COMMAND_LENGTH) {
    return {
      tokens: [],
      error: `$EDITOR exceeds the ${MAX_EDITOR_COMMAND_LENGTH}-character limit.`,
    };
  }

  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < editor.length; i += 1) {
    const character = editor[i]!;

    if (character === "\\") {
      const escaped = editor[i + 1];
      const escapesNext =
        escaped !== undefined &&
        (quote === '"'
          ? escaped === '"'
          : quote === null &&
            (/\s/u.test(escaped) || escaped === '"' || escaped === "'"));
      if (escapesNext) {
        token += escaped;
        tokenStarted = true;
        i += 1;
      } else {
        token += character;
        tokenStarted = true;
      }
      continue;
    }

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote !== null) {
    const kind = quote === '"' ? "double" : "single";
    return { tokens: [], error: `$EDITOR has an unterminated ${kind} quote.` };
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  if (tokens.length === 0 || tokens[0] === "") {
    return { tokens: [], error: "$EDITOR does not name a program." };
  }

  return { tokens, error: null };
}

function editorProgram(editor: string) {
  const { tokens } = splitEditorCommand(editor);
  const [firstToken = ""] = tokens;
  return basename(win32.basename(firstToken))
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
}

const VI_STYLE_EDITORS = ["vim", "nvim", "vi"];
const CODE_STYLE_EDITORS = ["code", "code-insiders", "cursor"];

/** Suspend for terminal editors. */
export function shouldSuspendForEditor(editor: string) {
  const program = editorProgram(editor);
  if (CODE_STYLE_EDITORS.includes(program)) {
    return false;
  }

  return true;
}

/** Build an editor process invocation without shell quoting so paths stay cross-platform. */
export function buildEditorCommand({
  editor,
  filePath,
  line,
}: {
  editor: string;
  filePath: string;
  line: number;
}): EditorCommand {
  const parsed = splitEditorCommand(editor);
  if (parsed.error) {
    return { command: "", args: [], error: parsed.error };
  }
  const [command = "", ...editorArgs] = parsed.tokens;
  const program = editorProgram(editor);

  if (VI_STYLE_EDITORS.includes(program)) {
    return { command, args: [...editorArgs, `+${line}`, filePath] };
  }

  if (CODE_STYLE_EDITORS.includes(program)) {
    return { command, args: [...editorArgs, "--goto", `${filePath}:${line}`] };
  }

  if (program == "hx") {
    return { command, args: [...editorArgs, `${filePath}:${line}`] };
  }

  return { command, args: [...editorArgs, filePath] };
}

/** The suspend/resume surface the round-trip needs (a CliRenderer subset). */
export interface SuspendableRenderer {
  suspend(): void;
  resume(): void;
  isDestroyed: boolean;
}

export interface EditorRoundTrip {
  /** The edited text, or null when the round-trip failed (see error). */
  text: string | null;
  error: string | null;
}

/**
 * Open an EXISTING repo file at a line in $EDITOR — the upstream
 * openSelectedFileInEditor behavior with the DiffFile coupling removed.
 * Terminal editors suspend the TUI and resume on exit; GUI editors
 * (code/cursor) spawn without suspending and detach. Per-editor line args
 * come from buildEditorCommand (`+LINE` for vi-style, `--goto file:LINE`
 * for code-style, `file:LINE` for helix, bare path otherwise).
 *
 * Returns an error message, or null on success (the upstream convention).
 */
export function openFileInEditor({
  renderer,
  env = process.env,
  root,
  file,
  line,
}: {
  renderer: SuspendableRenderer;
  env?: NodeJS.ProcessEnv;
  /** The repo root diff paths are relative to. */
  root: string;
  /** Repo-relative file path (a diff path). */
  file: string;
  /** 1-based line to land on (clamped up to 1). */
  line: number;
}): string | null {
  const editor = env.EDITOR?.trim();
  if (!editor) {
    return "$EDITOR is not set.";
  }
  const editorError = splitEditorCommand(editor).error;
  if (editorError) {
    return editorError;
  }

  const absolutePath = resolve(root, file);
  if (!existsSync(absolutePath)) {
    return `Cannot edit ${file}: file does not exist on disk.`;
  }

  const command = buildEditorCommand({
    editor,
    filePath: absolutePath,
    line: Math.max(1, Math.round(line)),
  });

  const shouldSuspend = shouldSuspendForEditor(editor);
  if (shouldSuspend) {
    renderer.suspend();
  }

  let exitCode = 0;
  let failureMessage: string | null = null;
  try {
    // Like editTextViaEditor: the child inherits the full process env (`env`
    // only selects the editor) so PATH/TERM survive an injected test env.
    const result = spawnSync(command.command, command.args, { stdio: "inherit" });
    if (result.error) {
      failureMessage = result.error.message;
    } else {
      exitCode = result.status ?? 0;
    }
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }

  if (shouldSuspend && !renderer.isDestroyed) {
    renderer.resume();
  }

  if (failureMessage) {
    return `Failed to launch editor: ${failureMessage}`;
  }

  if (exitCode !== 0) {
    return `Editor exited with status ${exitCode}.`;
  }

  return null;
}

/**
 * Temp-buffer $EDITOR round-trip: write `initialText` to a temp file, open
 * $EDITOR on it (suspending the TUI for terminal editors), and read the buffer
 * back on exit. GUI editors that detach immediately (code/cursor without a
 * blocking flag) cannot round-trip synchronously and are reported as an error —
 * inline input remains the primary path.
 */
export function editTextViaEditor({
  initialText,
  renderer,
  extension = ".md",
  env = process.env,
}: {
  initialText: string;
  renderer: SuspendableRenderer;
  extension?: string;
  env?: NodeJS.ProcessEnv;
}): EditorRoundTrip {
  const editor = env.EDITOR?.trim();
  if (!editor) {
    return { text: null, error: "$EDITOR is not set." };
  }
  const editorError = splitEditorCommand(editor).error;
  if (editorError) {
    return { text: null, error: editorError };
  }
  if (!shouldSuspendForEditor(editor)) {
    return {
      text: null,
      error: "$EDITOR detaches (GUI editor) — set a terminal editor for the round-trip.",
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "orcaops-note-"));
  const filePath = join(dir, `note${extension}`);
  try {
    writeFileSync(filePath, initialText, "utf8");
    const command = buildEditorCommand({ editor, filePath, line: 1 });

    renderer.suspend();
    let exitCode = 0;
    let failureMessage: string | null = null;
    try {
      const result = spawnSync(command.command, command.args, { stdio: "inherit" });
      if (result.error) {
        failureMessage = result.error.message;
      } else {
        exitCode = result.status ?? 0;
      }
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    if (!renderer.isDestroyed) {
      renderer.resume();
    }

    if (failureMessage) {
      return { text: null, error: `Failed to launch editor: ${failureMessage}` };
    }
    if (exitCode !== 0) {
      return { text: null, error: `Editor exited with status ${exitCode}.` };
    }
    return { text: readFileSync(filePath, "utf8"), error: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
