// Vendored from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path src/ui/diff/rowStyle.ts
// MIT License, Copyright (c) Ben Vinegar. Full text: packages/diff-render/LICENSE.
// Adaptations for @orcaops/diff-render:
//   - DiffCellFocus adds syntax-preserving subdued palettes and a one-cell
//     segmented rail for out-of-checkpoint code without changing row geometry.

import type { AppTheme } from "../themes";
import { blendHex } from "../lib/color";
import type { DiffCellFocus } from "./focusMask";
import type { SplitLineCell, StackLineCell } from "./pierre";

const INACTIVE_RAIL_BLEND = 0.35;
const SELECTION_BG_BLEND = 0.75;

/** The diff rail marker is always visible in Hunk stack and split rows. */
export function diffRailMarker(focus: DiffCellFocus = "primary") {
  return focus === "subdued" ? "┊" : "▌";
}

/**
 * Blend a base cell background toward the selection highlight color.
 *
 * blendHex(fg, bg, ratio) returns `bg + (fg - bg) * ratio`. We pass the highlight color as the
 * "front" and the cell's base bg as the "back", so a higher SELECTION_BG_BLEND pulls the result
 * harder toward the visible highlight color.
 */
export function selectionHighlightBg(baseBg: string, theme: AppTheme) {
  return blendHex(theme.selectedHunk, baseBg, SELECTION_BG_BLEND);
}

/** Return the neutral active-hunk rail color for the current theme. */
export function neutralRailColor(theme: AppTheme) {
  return theme.lineNumberFg;
}

/** Dim a rail color for inactive hunks by blending toward the panel background. */
export function dimRailColor(color: string, theme: AppTheme) {
  return blendHex(color, theme.panel, INACTIVE_RAIL_BLEND);
}

/** Pick the stack-view rail color for one rendered row. */
export function stackRailColor(
  kind: StackLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
  focus: DiffCellFocus = "primary",
) {
  if (focus === "subdued") {
    return theme.muted;
  }

  let color: string;

  if (kind === "addition") {
    color = theme.addedSignColor;
  } else if (kind === "deletion") {
    color = theme.removedSignColor;
  } else {
    color = neutralRailColor(theme);
  }

  return selected ? color : dimRailColor(color, theme);
}

/** Pick the left split-view rail color from the old-side cell state. */
export function splitLeftRailColor(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
  focus: DiffCellFocus = "primary",
) {
  if (focus === "subdued") {
    return theme.muted;
  }

  const color = kind === "deletion" ? theme.removedSignColor : neutralRailColor(theme);
  return selected ? color : dimRailColor(color, theme);
}

/** Pick the right split-view rail color from the new-side cell state. */
export function splitRightRailColor(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
  focus: DiffCellFocus = "primary",
) {
  if (focus === "subdued") {
    return theme.muted;
  }

  const color = kind === "addition" ? theme.addedSignColor : neutralRailColor(theme);
  return selected ? color : dimRailColor(color, theme);
}

/** Pick split-view colors from the semantic diff cell kind. */
export function splitCellPalette(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  moveKind?: SplitLineCell["moveKind"],
  focus: DiffCellFocus = "primary",
) {
  if (focus === "subdued") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.contextBg,
      signColor:
        kind === "addition"
          ? theme.addedSignColor
          : kind === "deletion"
            ? theme.removedSignColor
            : theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  if (kind === "addition") {
    return {
      gutterBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      contentBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      contentBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  if (kind === "empty") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.panelAlt,
      signColor: theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

/** Pick stack-view colors from the semantic diff cell kind. */
export function stackCellPalette(
  kind: StackLineCell["kind"],
  theme: AppTheme,
  moveKind?: StackLineCell["moveKind"],
  focus: DiffCellFocus = "primary",
) {
  if (focus === "subdued") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.contextBg,
      signColor:
        kind === "addition"
          ? theme.addedSignColor
          : kind === "deletion"
            ? theme.removedSignColor
            : theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  if (kind === "addition") {
    return {
      gutterBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      contentBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      contentBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

/** Keep intraline emphasis visible but softer when its changed cell is contextual. */
export function subduedWordDiffBackground(
  kind: SplitLineCell["kind"] | StackLineCell["kind"],
  theme: AppTheme,
) {
  if (kind === "addition") return theme.addedBg;
  if (kind === "deletion") return theme.removedBg;
  return theme.contextContentBg;
}

/** Format one optional line number for a fixed-width diff gutter. */
export function diffLineNumberText(value: number | undefined, width: number) {
  return value === undefined ? " ".repeat(width) : String(value).padStart(width, " ");
}

/** Build the stack-view gutter text shared by the TUI and static pager renderers. */
export function stackGutterText(
  cell: StackLineCell,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (!showLineNumbers) {
    return `${cell.sign} `;
  }

  const oldNumber = diffLineNumberText(cell.oldLineNumber, lineNumberDigits);
  const newNumber = diffLineNumberText(cell.newLineNumber, lineNumberDigits);
  return `${oldNumber} ${newNumber} ${cell.sign}`;
}

/** Build the split-view gutter text shared by the TUI and clipboard renderers. */
export function splitGutterText(
  cell: SplitLineCell,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (!showLineNumbers) {
    return `${cell.sign} `;
  }

  const number = cell.lineNumber
    ? String(cell.lineNumber).padStart(lineNumberDigits, " ")
    : " ".repeat(lineNumberDigits);
  return `${number} ${cell.sign}`;
}
