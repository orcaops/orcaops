// Vendored from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path src/ui/diff/pierre.ts
// MIT License, Copyright (c) Ben Vinegar. Full text: packages/diff-render/LICENSE.
// Adaptations for @orcaops/diff-render:
//   scheduled parsed-patch highlighting at hunk grain so navigation can paint between Shiki jobs.

import {
  cleanLastNewline,
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  renderFileWithHighlighter,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { formatHunkHeader } from "../../core/hunkHeader";
import type { DiffFile, DiffLineMoveKind } from "../../core/types";
import { blendHex, hexColorDistance } from "../lib/color";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { TRANSPARENT_BACKGROUND, type AppTheme } from "../themes";
import { expandDiffTabs } from "./codeColumns";
import { MAX_DERIVED_HIGHLIGHT_VARIANTS_PER_LINE } from "./highlightedDiffCache";

const PIERRE_THEME = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

type HighlightThemeInput = AppTheme | AppTheme["appearance"];

/** Resolve the default Pierre theme name needed for one light/dark appearance. */
function pierreThemeName(appearance: AppTheme["appearance"]) {
  return PIERRE_THEME[appearance];
}

/** Return the light/dark mode for a theme object or legacy appearance argument. */
function highlightThemeAppearance(theme: HighlightThemeInput) {
  return typeof theme === "string" ? theme : theme.appearance;
}

/** Resolve the Shiki/Pierre syntax theme that should color highlighted code. */
function highlighterThemeName(theme: HighlightThemeInput) {
  return typeof theme === "string"
    ? pierreThemeName(theme)
    : (theme.syntaxTheme ?? pierreThemeName(theme.appearance));
}

/** Build render options for the active syntax theme. */
function pierreRenderOptions(theme: HighlightThemeInput) {
  return {
    theme: highlighterThemeName(theme),
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  };
}

type HighlightOptions = ReturnType<typeof getHighlighterOptions>;

const highlighterOptionsByKey = new Map<string, HighlightOptions>();
let queuedHighlightWork = Promise.resolve();

/** Build a cache key for theme-dependent terminal colors, not just the stable UI theme id. */
function themeRenderCacheKey(theme: AppTheme) {
  return [
    theme.id,
    theme.syntaxTheme ?? "",
    theme.appearance,
    theme.background,
    theme.panelAlt,
    theme.contextBg,
    theme.addedBg,
    theme.removedBg,
    theme.addedContentBg,
    theme.removedContentBg,
    theme.addedSignColor,
    theme.removedSignColor,
    theme.syntaxColors.default,
    theme.syntaxColors.keyword,
    theme.syntaxColors.string,
    theme.syntaxColors.comment,
    theme.syntaxColors.number,
    theme.syntaxColors.function,
    theme.syntaxColors.property,
    theme.syntaxColors.type,
    theme.syntaxColors.variable ?? "",
    theme.syntaxColors.operator ?? "",
    theme.syntaxColors.punctuation,
  ].join(":");
}

type HastNode = HastTextNode | HastElementNode;

interface HastTextNode {
  type: "text";
  value: string;
}

interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface HighlightedDiffCode {
  deletionLines: Array<HastNode | undefined>;
  additionLines: Array<HastNode | undefined>;
}

export interface HighlightedSourceCode {
  lines: Array<HastNode | undefined>;
}

export interface RenderSpan {
  text: string;
  fg?: string;
  bg?: string;
}

export interface SplitLineCell {
  kind: "context" | "addition" | "deletion" | "empty";
  sign: string;
  lineNumber?: number;
  moveKind?: DiffLineMoveKind;
  spans: RenderSpan[];
}

export interface StackLineCell {
  kind: "context" | "addition" | "deletion";
  sign: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  moveKind?: DiffLineMoveKind;
  spans: RenderSpan[];
}

export type CollapsedGapPosition = "before" | "trailing";

export type DiffRow =
  | {
      type: "collapsed";
      key: string;
      fileId: string;
      hunkIndex: number;
      text: string;
      // Where this gap sits relative to the surrounding hunks; "before" attaches to
      // the gap leading into hunkIndex, "trailing" sits after the final hunk.
      position: CollapsedGapPosition;
      // 1-based inclusive file-line ranges this gap covers on each side. Expansion
      // uses these to slice the file contents that fill the gap.
      oldRange: [number, number];
      newRange: [number, number];
    }
  | {
      type: "hunk-header";
      key: string;
      fileId: string;
      hunkIndex: number;
      text: string;
    }
  | {
      type: "split-line";
      key: string;
      fileId: string;
      hunkIndex: number;
      left: SplitLineCell;
      right: SplitLineCell;
      // True when this row was synthesized to fill an expanded collapsed gap.
      // Expanded rows carry the neighbor hunk's index for ordering but must not
      // count toward that hunk's bounds or anchor position.
      isExpansionRow?: true;
    }
  | {
      type: "stack-line";
      key: string;
      fileId: string;
      hunkIndex: number;
      cell: StackLineCell;
      isExpansionRow?: true;
    };

/** Replace tabs with fixed spaces so terminal cell widths stay predictable. */
function tabify(text: string) {
  return expandDiffTabs(sanitizeTerminalLine(text));
}

const EMPTY_STYLE_VALUES = new Map<string, string>();
// Pierre reuses the same tiny set of inline style strings across many token spans.
// Caching the parsed key/value pairs avoids reparsing identical `color:#...` snippets
// every time split/stack row builders revisit the same highlighted lines.
const parsedStyleValueCache = new Map<string, Map<string, string>>();

/** Parse an inline CSS style string from Pierre's highlighted HAST output. */
function parseStyleValue(styleValue: unknown) {
  if (typeof styleValue !== "string") {
    return EMPTY_STYLE_VALUES;
  }

  const cached = parsedStyleValueCache.get(styleValue);
  if (cached) {
    return cached;
  }

  const styles = new Map<string, string>();
  for (const segment of styleValue.split(";")) {
    const separator = segment.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key && value) {
      styles.set(key, value);
    }
  }

  parsedStyleValueCache.set(styleValue, styles);
  return styles;
}

const RESERVED_PIERRE_TOKEN_COLORS = {
  dark: {
    "#ff6762": "keyword",
    "#ff855e": "keyword",
    "#ff678d": "keyword",
    "#d568ea": "keyword",
    "#9d6afb": "function",
    "#ffab16": "default",
    "#ffca00": "default",
    "#68cdf2": "number",
    "#5ecc71": "string",
    "#ffa359": "property",
    "#a3a3a3": "variable",
    "#08c0ef": "operator",
    "#636363": "punctuation",
  },
  light: {
    "#d52c36": "keyword",
    "#d5512f": "keyword",
    "#d32a61": "keyword",
    "#fc2b73": "keyword",
    "#a631be": "keyword",
    "#c635e4": "keyword",
    "#693acf": "function",
    "#7b43f8": "function",
    "#d5901c": "default",
    "#d5a910": "default",
    "#1ca1c7": "number",
    "#199f43": "string",
    "#d47628": "property",
    "#a3a3a3": "variable",
    "#08c0ef": "operator",
    "#636363": "punctuation",
  },
} as const;
// After style parsing, token colors still need one normalization step so syntax hues never
// collide with diff-semantic add/remove colors. Cache that remap per theme because themes that
// share an appearance can still use different syntax palettes.
const normalizedColorCache = new Map<string, Map<string, string>>();
// The expensive part after highlighting is walking Pierre's HAST line tree and flattening it
// into terminal spans. The same highlighted line objects are reused when files remount or when
// we build both split and stack rows, so memoize a tiny LRU of presentations by line node. Its
// shared policy makes the derived ephemeron lifetime bounded and lets the highlight LRU account
// for it instead of accumulating every custom-theme revision forever.
const flattenedHighlightedLineCache = new WeakMap<HastNode, Map<string, RenderSpan[]>>();
const MIN_WORD_DIFF_BG_DISTANCE = 28;
const WORD_DIFF_BLEND_STEP = 0.005;
const WORD_DIFF_MAX_BLEND = 0.2;
const wordDiffBackgroundCache = new Map<string, Record<SplitLineCell["kind"], string>>();

/** Blend toward the semantic sign color just enough to hit the minimum visible contrast. */
function strengthenWordDiffBg(lineBg: string, signColor: string) {
  let strongestCandidate = lineBg;
  const maxSteps = Math.floor(WORD_DIFF_MAX_BLEND / WORD_DIFF_BLEND_STEP);

  for (let step = 1; step <= maxSteps; step += 1) {
    const blendRatio = step * WORD_DIFF_BLEND_STEP;
    const candidate = blendHex(signColor, lineBg, blendRatio);
    strongestCandidate = candidate;

    if (hexColorDistance(candidate, lineBg) >= MIN_WORD_DIFF_BG_DISTANCE) {
      return candidate;
    }
  }

  return strongestCandidate;
}

/** Return whether a theme color can safely participate in RGB distance and blend math. */
function isHexThemeColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color);
}

/** Resolve one word-diff background without turning transparent surfaces into black blends. */
function resolveWordDiffHighlightBg(contentBg: string, lineBg: string, signColor: string) {
  if (contentBg === TRANSPARENT_BACKGROUND || lineBg === TRANSPARENT_BACKGROUND) {
    return contentBg;
  }

  if (!isHexThemeColor(contentBg) || !isHexThemeColor(lineBg)) {
    return contentBg;
  }

  return hexColorDistance(contentBg, lineBg) >= MIN_WORD_DIFF_BG_DISTANCE
    ? contentBg
    : strengthenWordDiffBg(lineBg, signColor);
}

/** Resolve the inline word-diff background, strengthening theme colors that are too subtle to see. */
function wordDiffHighlightBg(kind: SplitLineCell["kind"], theme: AppTheme) {
  const cacheKey = [themeRenderCacheKey(theme), theme.contextContentBg, theme.panelAlt].join(":");
  let cached = wordDiffBackgroundCache.get(cacheKey);
  if (!cached) {
    const addition = resolveWordDiffHighlightBg(
      theme.addedContentBg,
      theme.addedBg,
      theme.addedSignColor,
    );
    const deletion = resolveWordDiffHighlightBg(
      theme.removedContentBg,
      theme.removedBg,
      theme.removedSignColor,
    );

    cached = {
      addition,
      context: theme.contextContentBg,
      deletion,
      empty: theme.panelAlt,
    };
    wordDiffBackgroundCache.set(cacheKey, cached);
  }

  return cached[kind];
}

/** Remap Pierre token hues that collide with diff add/remove semantics into theme-safe syntax colors. */
function normalizeHighlightedColor(color: string | undefined, theme: AppTheme) {
  if (!color) {
    return color;
  }

  const themeKey = themeRenderCacheKey(theme);
  let cacheForTheme = normalizedColorCache.get(themeKey);
  if (!cacheForTheme) {
    cacheForTheme = new Map<string, string>();
    normalizedColorCache.set(themeKey, cacheForTheme);
  }

  const cached = cacheForTheme.get(color);
  if (cached) {
    return cached;
  }

  const normalized = color.trim().toLowerCase();
  const reserved =
    RESERVED_PIERRE_TOKEN_COLORS[theme.appearance][
      normalized as keyof (typeof RESERVED_PIERRE_TOKEN_COLORS)[typeof theme.appearance]
    ];
  const resolvedColor = reserved
    ? (theme.syntaxColors[reserved] ??
      (reserved === "operator" ? theme.syntaxColors.punctuation : theme.syntaxColors.default))
    : color;
  cacheForTheme.set(color, resolvedColor);
  return resolvedColor;
}

/** Append a span while coalescing adjacent runs with identical colors. */
function mergeSpan(target: RenderSpan[], next: RenderSpan) {
  if (next.text.length === 0) {
    return;
  }

  const previous = target[target.length - 1];
  if (previous && previous.fg === next.fg && previous.bg === next.bg) {
    previous.text += next.text;
    return;
  }

  target.push(next);
}

/** Flatten one highlighted HAST line into terminal-friendly styled text spans. */
function flattenHighlightedLine(node: HastNode | undefined, theme: AppTheme, emphasisBg: string) {
  if (!node) {
    return [];
  }

  const cacheKey = `${themeRenderCacheKey(theme)}:${emphasisBg}`;
  const cachedByTheme = flattenedHighlightedLineCache.get(node);
  const cached = cachedByTheme?.get(cacheKey);
  if (cached) {
    cachedByTheme?.delete(cacheKey);
    cachedByTheme?.set(cacheKey, cached);
    return cached;
  }

  // Cache hits here are what make revisiting/remounting already-highlighted files cheap:
  // we skip the full recursive walk and return the already-flattened terminal spans.

  const spans: RenderSpan[] = [];
  const colorVariable = theme.appearance === "light" ? "--diffs-token-light" : "--diffs-token-dark";

  const visit = (current: HastNode | undefined, inherited: Pick<RenderSpan, "fg" | "bg">) => {
    if (!current) {
      return;
    }

    if (current.type === "text") {
      // Pierre injects a "\n" placeholder into empty line nodes so they aren't childless.
      // Strip it the same way cleanDiffLine does for the unhighlighted path, or the literal
      // newline ends up in the span text and breaks terminal row rendering.
      mergeSpan(spans, {
        text: tabify(cleanLastNewline(current.value)),
        fg: inherited.fg,
        bg: inherited.bg,
      });
      return;
    }

    const properties = current.properties ?? {};
    const styles = parseStyleValue(properties.style);
    const nextStyle: Pick<RenderSpan, "fg" | "bg"> = {
      // Newer Pierre output can emit direct `color:#...` styles instead of theme CSS variables.
      fg: normalizeHighlightedColor(
        styles.get(colorVariable) ?? styles.get("color") ?? inherited.fg,
        theme,
      ),
      // Pierre marks inline word-diff emphasis spans with a data attribute rather than a separate row kind.
      bg: Object.hasOwn(properties, "data-diff-span") ? emphasisBg : inherited.bg,
    };

    for (const child of current.children ?? []) {
      visit(child, nextStyle);
    }
  };

  visit(node, {});

  const nextCachedByTheme = cachedByTheme ?? new Map<string, RenderSpan[]>();
  nextCachedByTheme.set(cacheKey, spans);
  while (nextCachedByTheme.size > MAX_DERIVED_HIGHLIGHT_VARIANTS_PER_LINE) {
    const oldestKey = nextCachedByTheme.keys().next().value;
    if (oldestKey === undefined) break;
    nextCachedByTheme.delete(oldestKey);
  }
  if (!cachedByTheme) flattenedHighlightedLineCache.set(node, nextCachedByTheme);

  return spans;
}

/** Normalize one raw diff line before rendering. */
function cleanDiffLine(line: string | undefined) {
  return tabify(cleanLastNewline(line ?? ""));
}

/** Build the normalized render model for one split-view cell. */
function makeSplitCell(
  kind: SplitLineCell["kind"],
  lineNumber: number | undefined,
  rawLine: string | undefined,
  highlightedLine: HastNode | undefined,
  theme: AppTheme,
  moveKind?: DiffLineMoveKind,
) {
  if (kind === "empty") {
    return {
      kind,
      sign: " ",
      spans: [],
    } satisfies SplitLineCell;
  }

  // Startup renders often build rows before highlighted HAST exists, so keep that plain-text path cheap.
  // Once highlighted spans are available, avoid touching the raw source line unless flattening
  // produced nothing. That keeps newline stripping + tab expansion off the hot path.
  let spans: RenderSpan[];
  if (highlightedLine === undefined) {
    const fallbackText = cleanDiffLine(rawLine);
    spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  } else {
    spans = flattenHighlightedLine(highlightedLine, theme, wordDiffHighlightBg(kind, theme));

    if (spans.length === 0) {
      const fallbackText = cleanDiffLine(rawLine);
      spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
    }
  }

  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    lineNumber,
    moveKind,
    spans,
  } satisfies SplitLineCell;
}

/** Build the normalized render model for one stack-view cell. */
function makeStackCell(
  kind: StackLineCell["kind"],
  oldLineNumber: number | undefined,
  newLineNumber: number | undefined,
  rawLine: string | undefined,
  highlightedLine: HastNode | undefined,
  theme: AppTheme,
  moveKind?: DiffLineMoveKind,
) {
  // Same lazy-fallback strategy as split cells: only normalize the raw source line when we really
  // need the plain-text fallback, not when highlighted spans are already ready to reuse.
  let spans: RenderSpan[];
  if (highlightedLine === undefined) {
    const fallbackText = cleanDiffLine(rawLine);
    spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  } else {
    spans = flattenHighlightedLine(highlightedLine, theme, wordDiffHighlightBg(kind, theme));

    if (spans.length === 0) {
      const fallbackText = cleanDiffLine(rawLine);
      spans = fallbackText.length > 0 ? [{ text: fallbackText }] : [];
    }
  }

  return {
    kind,
    sign: kind === "addition" ? "+" : kind === "deletion" ? "-" : " ",
    oldLineNumber,
    newLineNumber,
    moveKind,
    spans,
  } satisfies StackLineCell;
}

/** Describe one collapsed unchanged region in the diff stream. */
function collapsedRowText(lines: number) {
  return `${lines} unchanged ${lines === 1 ? "line" : "lines"}`;
}

/** Compute the file-line ranges covered by the gap leading into one hunk. */
function leadingCollapsedRanges(hunk: FileDiffMetadata["hunks"][number]) {
  return {
    oldRange: [hunk.deletionStart - hunk.collapsedBefore, hunk.deletionStart - 1] as [
      number,
      number,
    ],
    newRange: [hunk.additionStart - hunk.collapsedBefore, hunk.additionStart - 1] as [
      number,
      number,
    ],
  };
}

/** Compute the file-line ranges covered by the trailing gap after the final hunk. */
function trailingCollapsedRanges(
  lastHunk: FileDiffMetadata["hunks"][number],
  trailingLines: number,
) {
  const oldStart = lastHunk.deletionStart + lastHunk.deletionCount;
  const newStart = lastHunk.additionStart + lastHunk.additionCount;
  return {
    oldRange: [oldStart, oldStart + trailingLines - 1] as [number, number],
    newRange: [newStart, newStart + trailingLines - 1] as [number, number],
  };
}

/** Count hidden unchanged lines after the final visible hunk when Pierre omits them. */
export function trailingCollapsedLines(metadata: FileDiffMetadata) {
  const lastHunk = metadata.hunks.at(-1);
  if (!lastHunk || metadata.isPartial) {
    return 0;
  }

  const additionRemaining =
    metadata.additionLines.length - (lastHunk.additionLineIndex + lastHunk.additionCount);
  const deletionRemaining =
    metadata.deletionLines.length - (lastHunk.deletionLineIndex + lastHunk.deletionCount);

  if (additionRemaining !== deletionRemaining) {
    return 0;
  }

  return Math.max(additionRemaining, 0);
}

/** Prepare syntax highlighting for one language/theme pair using Pierre's shared highlighter. */
async function prepareHighlighter(language: string | undefined, theme: HighlightThemeInput) {
  const resolvedLanguage = language ?? "text";
  const syntaxTheme = highlighterThemeName(theme);
  const cacheKey = `${syntaxTheme}:${resolvedLanguage}`;
  const options =
    highlighterOptionsByKey.get(cacheKey) ??
    getHighlighterOptions(resolvedLanguage, {
      theme: syntaxTheme,
    });

  if (!highlighterOptionsByKey.has(cacheKey)) {
    highlighterOptionsByKey.set(cacheKey, options);
  }

  return getSharedHighlighter({
    ...options,
    preferredHighlighter: "shiki-wasm",
  });
}

/** Queue highlight rendering so startup work stays serialized without starving input/render timers. */
function queueHighlightedWork<T>(run: () => T) {
  const queued = queuedHighlightWork.then(
    () =>
      new Promise<T>((resolve, reject) => {
        // Highlighting is CPU-heavy background work. Scheduling each serialized job as a timer,
        // rather than a microtask, yields back to OpenTUI input and frame timers between files.
        setTimeout(() => {
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        }, 0);
      }),
  );

  queuedHighlightWork = queued.then(
    () => undefined,
    () => undefined,
  );

  return queued;
}

/** Normalize source text the same way expanded-row slicing does before highlighting. */
function normalizeSourceText(text: string) {
  return text.replaceAll("\r\n", "\n");
}

/** Build Pierre file contents for a full-source highlight request. */
function sourceFileContents(file: DiffFile, text: string, language: string | undefined) {
  const contents: FileContents = {
    name: file.path,
    contents: normalizeSourceText(text),
    cacheKey: `${file.id}:${file.path}:${language ?? ""}:${text.length}`,
  };

  if (language) {
    contents.lang = language as FileContents["lang"];
  }

  return contents;
}

/**
 * Pierre highlights unchanged context on both diff sides even though split/stack rendering later
 * cares only about the styled code spans. Reuse one side's line node for both arrays so identical
 * context flattens once and the existing WeakMap span cache can fan that result back out.
 */
function aliasHighlightedContextLines(file: DiffFile, highlighted: HighlightedDiffCode) {
  for (const hunk of file.metadata.hunks) {
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const sharedLine =
            highlighted.additionLines[additionLineIndex + offset] ??
            highlighted.deletionLines[deletionLineIndex + offset];

          if (!sharedLine) {
            continue;
          }

          highlighted.deletionLines[deletionLineIndex + offset] = sharedLine;
          highlighted.additionLines[additionLineIndex + offset] = sharedLine;
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        continue;
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
    }
  }

  return highlighted;
}

/** Highlight a diff file and return just the rendered line trees the UI needs. */
export async function loadHighlightedDiff(
  file: DiffFile,
  theme: HighlightThemeInput = "dark",
): Promise<HighlightedDiffCode> {
  // Pierre already tokenizes parsed patches hunk by hunk internally. Scheduling those same jobs
  // separately preserves its output while preventing a many-hunk file from monopolizing the TUI
  // event loop. This path also keeps explicit whole-file prefetch callers cooperative.
  if (file.metadata.isPartial) {
    const combined: HighlightedDiffCode = { deletionLines: [], additionLines: [] };
    for (const hunkIndex of file.metadata.hunks.keys()) {
      const hunk = await loadHighlightedDiffHunk(file, hunkIndex, theme);
      for (const [index, line] of hunk.deletionLines.entries()) {
        if (line) combined.deletionLines[index] = line;
      }
      for (const [index, line] of hunk.additionLines.entries()) {
        if (line) combined.additionLines[index] = line;
      }
    }
    return aliasHighlightedContextLines(file, combined);
  }

  try {
    const highlighter = await prepareHighlighter(file.language, theme);
    return queueHighlightedWork(() => {
      const highlighted = renderDiffWithHighlighter(
        file.metadata,
        highlighter,
        pierreRenderOptions(theme),
      );
      return aliasHighlightedContextLines(file, {
        deletionLines: highlighted.code.deletionLines as Array<HastNode | undefined>,
        additionLines: highlighted.code.additionLines as Array<HastNode | undefined>,
      });
    });
  } catch {
    const fallbackTheme = highlightThemeAppearance(theme);
    const highlighter = await prepareHighlighter("text", fallbackTheme);
    return queueHighlightedWork(() => {
      const highlighted = renderDiffWithHighlighter(
        { ...file.metadata, lang: "text" },
        highlighter,
        pierreRenderOptions(fallbackTheme),
      );
      return aliasHighlightedContextLines(file, {
        deletionLines: highlighted.code.deletionLines as Array<HastNode | undefined>,
        additionLines: highlighted.code.additionLines as Array<HastNode | undefined>,
      });
    });
  }
}

/**
 * Build the smallest Pierre metadata object that preserves one hunk's diff semantics.
 *
 * Parsed patches are already highlighted one hunk at a time inside Pierre; slicing before the
 * synchronous Shiki call simply gives the event loop a scheduling boundary between those hunks.
 * The returned offsets map Pierre's compact result back into the original file-wide line arrays.
 */
export function sliceMetadataForHunkHighlight(file: DiffFile, hunkIndex: number) {
  const hunk = file.metadata.hunks[hunkIndex];
  if (!hunk) return null;

  const deletionOffset = hunk.deletionLineIndex;
  const additionOffset = hunk.additionLineIndex;
  const metadata: FileDiffMetadata = {
    ...file.metadata,
    cacheKey: `${file.metadata.cacheKey ?? file.id}:hunk:${hunkIndex}`,
    hunks: [
      {
        ...hunk,
        collapsedBefore: 0,
        deletionLineIndex: 0,
        additionLineIndex: 0,
        splitLineStart: 0,
        unifiedLineStart: 0,
        hunkContent: hunk.hunkContent.map((content) => ({
          ...content,
          deletionLineIndex: content.deletionLineIndex - deletionOffset,
          additionLineIndex: content.additionLineIndex - additionOffset,
        })),
      },
    ],
    deletionLines: file.metadata.deletionLines.slice(
      deletionOffset,
      deletionOffset + hunk.deletionCount,
    ),
    additionLines: file.metadata.additionLines.slice(
      additionOffset,
      additionOffset + hunk.additionCount,
    ),
    splitLineCount: hunk.splitLineCount,
    unifiedLineCount: hunk.unifiedLineCount,
    // Hunk-scoped highlighting is valid only for parsed patches. Keep that invariant explicit so
    // Pierre neither groups this slice with full-file source nor attempts context expansion.
    isPartial: true,
  };

  return { metadata, deletionOffset, additionOffset };
}

/** Map compact hunk-local HAST arrays back into the indices consumed by the row builders. */
function placeHighlightedHunk(
  file: DiffFile,
  hunkIndex: number,
  highlighted: HighlightedDiffCode,
): HighlightedDiffCode {
  const sliced = sliceMetadataForHunkHighlight(file, hunkIndex);
  if (!sliced) return { deletionLines: [], additionLines: [] };

  const placed: HighlightedDiffCode = { deletionLines: [], additionLines: [] };
  for (const [index, line] of highlighted.deletionLines.entries()) {
    placed.deletionLines[sliced.deletionOffset + index] = line;
  }
  for (const [index, line] of highlighted.additionLines.entries()) {
    placed.additionLines[sliced.additionOffset + index] = line;
  }
  return aliasHighlightedContextLines(file, placed);
}

/**
 * Highlight one mounted hunk per scheduled job.
 *
 * Whole-file highlighting is a long synchronous Shiki task even though the first paint already
 * uses plain rows. Keeping one hunk per timer preserves eventual syntax and word-diff styling while
 * ensuring navigation can commit between jobs. Non-partial metadata falls back to the full-file
 * path because its language state and expansion context may span the complete source.
 */
export async function loadHighlightedDiffHunk(
  file: DiffFile,
  hunkIndex: number,
  theme: HighlightThemeInput = "dark",
): Promise<HighlightedDiffCode> {
  if (!file.metadata.isPartial) return loadHighlightedDiff(file, theme);

  const sliced = sliceMetadataForHunkHighlight(file, hunkIndex);
  if (!sliced) return { deletionLines: [], additionLines: [] };

  const render = (highlighter: Awaited<ReturnType<typeof prepareHighlighter>>, fallback = false) =>
    queueHighlightedWork(() => {
      const highlighted = renderDiffWithHighlighter(
        fallback ? { ...sliced.metadata, lang: "text" } : sliced.metadata,
        highlighter,
        pierreRenderOptions(fallback ? highlightThemeAppearance(theme) : theme),
      );
      return placeHighlightedHunk(file, hunkIndex, {
        deletionLines: highlighted.code.deletionLines as Array<HastNode | undefined>,
        additionLines: highlighted.code.additionLines as Array<HastNode | undefined>,
      });
    });

  try {
    return await render(await prepareHighlighter(file.language, theme));
  } catch {
    const fallbackTheme = highlightThemeAppearance(theme);
    return render(await prepareHighlighter("text", fallbackTheme), true);
  }
}

/** Highlight a full source file for unchanged lines synthesized during gap expansion. */
export async function loadHighlightedSourceLines({
  file,
  text,
  theme = "dark",
}: {
  file: DiffFile;
  text: string;
  theme?: HighlightThemeInput;
}): Promise<HighlightedSourceCode> {
  try {
    const highlighter = await prepareHighlighter(file.language, theme);
    return queueHighlightedWork(() => {
      const highlighted = renderFileWithHighlighter(
        sourceFileContents(file, text, file.language),
        highlighter,
        pierreRenderOptions(theme),
      );
      return {
        lines: highlighted.code as Array<HastNode | undefined>,
      };
    });
  } catch {
    const fallbackTheme = highlightThemeAppearance(theme);
    const highlighter = await prepareHighlighter("text", fallbackTheme);
    return queueHighlightedWork(() => {
      const highlighted = renderFileWithHighlighter(
        sourceFileContents(file, text, "text"),
        highlighter,
        pierreRenderOptions(fallbackTheme),
      );
      return {
        lines: highlighted.code as Array<HastNode | undefined>,
      };
    });
  }
}

/** Convert one highlighted full-source line into the spans used by expanded context rows. */
export function spansForHighlightedSourceLine(
  rawLine: string | undefined,
  highlightedLine: HastNode | undefined,
  theme: AppTheme,
): RenderSpan[] {
  if (highlightedLine === undefined) {
    const fallbackText = cleanDiffLine(rawLine);
    return fallbackText.length > 0 ? [{ text: fallbackText }] : [];
  }

  const spans = flattenHighlightedLine(highlightedLine, theme, theme.contextContentBg);
  if (spans.length > 0) {
    return spans;
  }

  const fallbackText = cleanDiffLine(rawLine);
  return fallbackText.length > 0 ? [{ text: fallbackText }] : [];
}

/** Expand Pierre metadata into the flat split-view row stream consumed by the renderer. */
function buildSplitRowsInternal(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
  onlyHunkIndex?: number,
  structureOnly = false,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const deletionLines = highlighted?.deletionLines ?? [];
  const additionLines = highlighted?.additionLines ?? [];

  const selectedHunk =
    onlyHunkIndex === undefined ? undefined : file.metadata.hunks[onlyHunkIndex];
  const hunks: Iterable<readonly [number, FileDiffMetadata["hunks"][number]]> =
    onlyHunkIndex === undefined
      ? file.metadata.hunks.entries()
      : selectedHunk === undefined
        ? []
        : [[onlyHunkIndex, selectedHunk] as const];

  for (const [hunkIndex, hunk] of hunks) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        type: "collapsed",
        key: `${file.id}:collapsed:${hunkIndex}`,
        fileId: file.id,
        hunkIndex,
        text: collapsedRowText(hunk.collapsedBefore),
        position: "before",
        ...leadingCollapsedRanges(hunk),
      });
    }

    rows.push({
      type: "hunk-header",
      key: `${file.id}:header:${hunkIndex}`,
      fileId: file.id,
      hunkIndex,
      text: formatHunkHeader(hunk),
    });

    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            type: "split-line",
            key: `${file.id}:split:${hunkIndex}:context:${deletionLineIndex + offset}:${additionLineIndex + offset}`,
            fileId: file.id,
            hunkIndex,
            left: makeSplitCell(
              "context",
              deletionLineNumber + offset,
              structureOnly ? undefined : file.metadata.deletionLines[deletionLineIndex + offset],
              deletionLines[deletionLineIndex + offset],
              theme,
            ),
            right: makeSplitCell(
              "context",
              additionLineNumber + offset,
              structureOnly ? undefined : file.metadata.additionLines[additionLineIndex + offset],
              additionLines[additionLineIndex + offset],
              theme,
            ),
          });
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      // Split mode keeps deletions and additions visually paired, padding the shorter side with empty cells.
      const pairedLines = Math.max(content.deletions, content.additions);
      for (let offset = 0; offset < pairedLines; offset += 1) {
        const hasDeletion = offset < content.deletions;
        const hasAddition = offset < content.additions;

        rows.push({
          type: "split-line",
          key: `${file.id}:split:${hunkIndex}:change:${deletionLineIndex + offset}:${additionLineIndex + offset}`,
          fileId: file.id,
          hunkIndex,
          left: hasDeletion
            ? makeSplitCell(
                "deletion",
                deletionLineNumber + offset,
                structureOnly
                  ? undefined
                  : file.metadata.deletionLines[deletionLineIndex + offset],
                deletionLines[deletionLineIndex + offset],
                theme,
                file.lineMoveKinds?.deletionLines[deletionLineIndex + offset],
              )
            : makeSplitCell("empty", undefined, undefined, undefined, theme),
          right: hasAddition
            ? makeSplitCell(
                "addition",
                additionLineNumber + offset,
                structureOnly
                  ? undefined
                  : file.metadata.additionLines[additionLineIndex + offset],
                additionLines[additionLineIndex + offset],
                theme,
                file.lineMoveKinds?.additionLines[additionLineIndex + offset],
              )
            : makeSplitCell("empty", undefined, undefined, undefined, theme),
        });
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }
  }

  const trailingLines = trailingCollapsedLines(file.metadata);
  const lastHunk = file.metadata.hunks.at(-1);
  if (
    trailingLines > 0 &&
    lastHunk &&
    (onlyHunkIndex === undefined || onlyHunkIndex === file.metadata.hunks.length - 1)
  ) {
    rows.push({
      type: "collapsed",
      key: `${file.id}:collapsed:trailing`,
      fileId: file.id,
      hunkIndex: file.metadata.hunks.length - 1,
      text: collapsedRowText(trailingLines),
      position: "trailing",
      ...trailingCollapsedRanges(lastHunk, trailingLines),
    });
  }

  return rows;
}

/** Build the complete split-view row stream for a file. */
export function buildSplitRows(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
): DiffRow[] {
  return buildSplitRowsInternal(file, highlighted, theme);
}

/**
 * Build one canonical split-view hunk without expanding every sibling hunk in
 * the file. Row keys and full-file source indices remain identical to filtering
 * `buildSplitRows`, including the trailing collapsed row on the final hunk.
 */
export function buildSplitRowsForHunk(
  file: DiffFile,
  hunkIndex: number,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
): DiffRow[] {
  return buildSplitRowsInternal(file, highlighted, theme, hunkIndex);
}

/**
 * Build the split row identities needed by geometry/navigation without
 * normalizing offscreen source text into render spans. Every key, kind, source
 * line number, and collapsed range is identical to buildSplitRowsForHunk.
 */
export function buildSplitStructureRowsForHunk(
  file: DiffFile,
  hunkIndex: number,
  theme: AppTheme,
): DiffRow[] {
  return buildSplitRowsInternal(file, null, theme, hunkIndex, true);
}

/** Expand Pierre metadata into the flat stack-view row stream consumed by the renderer. */
function buildStackRowsInternal(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
  onlyHunkIndex?: number,
  structureOnly = false,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const deletionLines = highlighted?.deletionLines ?? [];
  const additionLines = highlighted?.additionLines ?? [];

  const selectedHunk =
    onlyHunkIndex === undefined ? undefined : file.metadata.hunks[onlyHunkIndex];
  const hunks: Iterable<readonly [number, FileDiffMetadata["hunks"][number]]> =
    onlyHunkIndex === undefined
      ? file.metadata.hunks.entries()
      : selectedHunk === undefined
        ? []
        : [[onlyHunkIndex, selectedHunk] as const];

  for (const [hunkIndex, hunk] of hunks) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        type: "collapsed",
        key: `${file.id}:stack:collapsed:${hunkIndex}`,
        fileId: file.id,
        hunkIndex,
        text: collapsedRowText(hunk.collapsedBefore),
        position: "before",
        ...leadingCollapsedRanges(hunk),
      });
    }

    rows.push({
      type: "hunk-header",
      key: `${file.id}:stack:header:${hunkIndex}`,
      fileId: file.id,
      hunkIndex,
      text: formatHunkHeader(hunk),
    });

    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            type: "stack-line",
            key: `${file.id}:stack:${hunkIndex}:context:${deletionLineIndex + offset}:${additionLineIndex + offset}`,
            fileId: file.id,
            hunkIndex,
            cell: makeStackCell(
              "context",
              deletionLineNumber + offset,
              additionLineNumber + offset,
              structureOnly ? undefined : file.metadata.additionLines[additionLineIndex + offset],
              additionLines[additionLineIndex + offset],
              theme,
            ),
          });
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        rows.push({
          type: "stack-line",
          key: `${file.id}:stack:${hunkIndex}:deletion:${deletionLineIndex + offset}`,
          fileId: file.id,
          hunkIndex,
          cell: makeStackCell(
            "deletion",
            deletionLineNumber + offset,
            undefined,
            structureOnly ? undefined : file.metadata.deletionLines[deletionLineIndex + offset],
            deletionLines[deletionLineIndex + offset],
            theme,
            file.lineMoveKinds?.deletionLines[deletionLineIndex + offset],
          ),
        });
      }

      for (let offset = 0; offset < content.additions; offset += 1) {
        rows.push({
          type: "stack-line",
          key: `${file.id}:stack:${hunkIndex}:addition:${additionLineIndex + offset}`,
          fileId: file.id,
          hunkIndex,
          cell: makeStackCell(
            "addition",
            undefined,
            additionLineNumber + offset,
            structureOnly ? undefined : file.metadata.additionLines[additionLineIndex + offset],
            additionLines[additionLineIndex + offset],
            theme,
            file.lineMoveKinds?.additionLines[additionLineIndex + offset],
          ),
        });
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }
  }

  const trailingLines = trailingCollapsedLines(file.metadata);
  const lastHunk = file.metadata.hunks.at(-1);
  if (
    trailingLines > 0 &&
    lastHunk &&
    (onlyHunkIndex === undefined || onlyHunkIndex === file.metadata.hunks.length - 1)
  ) {
    rows.push({
      type: "collapsed",
      key: `${file.id}:stack:collapsed:trailing`,
      fileId: file.id,
      hunkIndex: file.metadata.hunks.length - 1,
      text: collapsedRowText(trailingLines),
      position: "trailing",
      ...trailingCollapsedRanges(lastHunk, trailingLines),
    });
  }

  return rows;
}

/** Build the complete stack-view row stream for a file. */
export function buildStackRows(
  file: DiffFile,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
): DiffRow[] {
  return buildStackRowsInternal(file, highlighted, theme);
}

/**
 * Build one canonical stack-view hunk without expanding every sibling hunk in
 * the file. Its output is byte-for-byte the matching filtered full-file rows.
 */
export function buildStackRowsForHunk(
  file: DiffFile,
  hunkIndex: number,
  highlighted: HighlightedDiffCode | null,
  theme: AppTheme,
): DiffRow[] {
  return buildStackRowsInternal(file, highlighted, theme, hunkIndex);
}

/** Stack counterpart to buildSplitStructureRowsForHunk. */
export function buildStackStructureRowsForHunk(
  file: DiffFile,
  hunkIndex: number,
  theme: AppTheme,
): DiffRow[] {
  return buildStackRowsInternal(file, null, theme, hunkIndex, true);
}
