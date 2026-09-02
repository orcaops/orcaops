// Vendored from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path src/ui/components/panes/AgentInlineNote.tsx
// MIT License, Copyright (c) Ben Vinegar. Full text: packages/diff-render/LICENSE.
// Adaptations for @orcaops/diff-render:
//   - extracted the draft-note textarea composer core (line-count/soft-wrap
//     management, viewport reset after growth, newline/save/escape key handling —
//     source :32-56, :149-245, :336-412) as the reusable TextComposer; the
//     annotation-thread rendering and the hand-drawn card chrome are NOT vendored
//     (the consuming app draws its own modal chrome).
//   - the annotation/draft model props are replaced by plain
//     {initialValue, placeholder, onSubmit, onCancel, onEditorRequest} props and
//     explicit colors; ^E requests an external-editor round-trip from the parent
//     (see ../lib/openInEditor.ts) — an addition, not upstream behavior.

import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { flushSync } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";

import { isEscapeKey, isSaveDraftNoteKey } from "../lib/keyboard";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function draftLineCount(text: string) {
  return Math.max(1, text.split("\n").length);
}

/** Estimate the textarea's wrapped visual row count for a given content width. */
export function draftVisualLineCount(text: string, width: number) {
  const usableWidth = Math.max(1, width);
  return Math.max(
    1,
    text
      .split("\n")
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / usableWidth)), 0),
  );
}

export function isNewlineKey(key: { ctrl?: boolean; name?: string; sequence?: string }) {
  return (
    key.name === "return" ||
    key.name === "enter" ||
    key.name === "linefeed" ||
    key.sequence === "\r" ||
    key.sequence === "\n" ||
    (key.ctrl && key.name === "j")
  );
}

/** ^E — hand the draft to $EDITOR (our addition; not an upstream binding). */
function isEditorRequestKey(key: { ctrl?: boolean; name?: string; sequence?: string }) {
  return key.ctrl === true && (key.name === "e" || key.sequence === "e");
}

export interface TextComposerProps {
  /** Content width of the textarea (the parent draws any chrome around it). */
  width: number;
  /** The composer grows with its content up to this many rows. */
  maxRows?: number;
  initialValue?: string;
  placeholder?: string;
  focused: boolean;
  textColor: string;
  backgroundColor: string;
  /** ^S (raw / Kitty CSI-u / tmux encodings). */
  onSubmit: (text: string) => void;
  /** Escape. */
  onCancel: () => void;
  /** ^E with the current draft — the parent runs the $EDITOR round-trip. */
  onEditorRequest?: (currentText: string) => void;
  /** Mirrors the live draft for pointer-driven actions outside the textarea. */
  onChange?: (text: string) => void;
}

/**
 * The multi-line composer: an OpenTUI textarea that grows with its content
 * (soft wraps included) up to `maxRows`. Enter inserts a newline (`^J` too);
 * `^S` submits, escape cancels, `^E` optionally hands off to $EDITOR. To reset
 * the content programmatically (e.g. after an editor round-trip), remount with
 * a new `key` and `initialValue`.
 */
export function TextComposer({
  width,
  maxRows = 8,
  initialValue = "",
  placeholder,
  focused,
  textColor,
  backgroundColor,
  onSubmit,
  onCancel,
  onEditorRequest,
  onChange,
}: TextComposerProps) {
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const [body, setBody] = useState(initialValue);
  const [lineCountHint, setLineCountHint] = useState(() => draftLineCount(initialValue));

  const contentWidth = Math.max(1, width);
  const visibleRows = clamp(
    Math.max(lineCountHint, draftVisualLineCount(body, contentWidth)),
    1,
    Math.max(1, maxRows),
  );

  useLayoutEffect(() => {
    if (visibleRows <= 0) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const viewport = textarea.editorView.getViewport();
    if (viewport.offsetY === 0 && viewport.height === visibleRows) {
      return;
    }

    // The textarea follows the cursor after Enter while its old one-line viewport is still active.
    // Once the composer grows to fit the new line, reset the viewport so previous lines stay visible.
    textarea.editorView.setViewport(viewport.offsetX, 0, viewport.width, visibleRows, false);
    textarea.requestRender();
  }, [visibleRows]);

  const updateLineCountHint = (nextLineCount: number) => {
    flushSync(() => {
      setLineCountHint(nextLineCount);
    });
  };

  const currentText = () => textareaRef.current?.plainText ?? body;

  return (
    <textarea
      ref={textareaRef}
      width={contentWidth}
      height={visibleRows}
      initialValue={initialValue}
      placeholder={placeholder}
      focused={focused}
      backgroundColor={backgroundColor}
      textColor={textColor}
      focusedBackgroundColor={backgroundColor}
      focusedTextColor={textColor}
      keyBindings={[{ name: "j", ctrl: true, action: "newline" }]}
      onContentChange={() => {
        const textarea = textareaRef.current;
        const nextBody = textarea?.plainText ?? "";
        updateLineCountHint(
          Math.max(
            draftVisualLineCount(nextBody, contentWidth),
            textarea?.virtualLineCount ?? 0,
          ),
        );
        setBody(nextBody);
        onChange?.(nextBody);
      }}
      onKeyDown={(key: KeyEvent) => {
        if (isNewlineKey(key)) {
          updateLineCountHint(draftVisualLineCount(currentText(), contentWidth) + 1);
        }

        if (isSaveDraftNoteKey(key)) {
          key.preventDefault();
          key.stopPropagation();
          onSubmit(currentText());
          return;
        }

        if (isEscapeKey(key)) {
          key.preventDefault();
          key.stopPropagation();
          onCancel();
          return;
        }

        if (onEditorRequest && isEditorRequestKey(key)) {
          key.preventDefault();
          key.stopPropagation();
          onEditorRequest(currentText());
        }
      }}
    />
  );
}
