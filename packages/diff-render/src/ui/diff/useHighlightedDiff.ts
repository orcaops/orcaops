// Vendored from hunk (https://github.com/modem-dev/hunk) @ 9ef9b2e, source path src/ui/diff/useHighlightedDiff.ts
// MIT License, Copyright (c) Ben Vinegar. Full text: packages/diff-render/LICENSE.
// Adaptations for @orcaops/diff-render:
//   weight-bounded shared caching plus hunk-scoped loading for mounted parsed-patch slices.

import { useLayoutEffect, useState } from "react";
import type { DiffFile } from "../../core/types";
import type { AppTheme } from "../themes";
import { HighlightedDiffCache } from "./highlightedDiffCache";
import {
  loadHighlightedDiff,
  loadHighlightedDiffHunk,
  type HighlightedDiffCode,
} from "./pierre";

const SHARED_HIGHLIGHTED_DIFF_CACHE = new HighlightedDiffCache();
const SHARED_HIGHLIGHT_PROMISES = new Map<string, Promise<HighlightedDiffCode>>();
const FILE_CONTENT_GENERATION_IDS = new WeakMap<DiffFile["metadata"], number>();
let nextFileContentGenerationId = 1;

/**
 * A hunk that remains mounted for one short frame is likely to stay visible. Fleeting virtualization
 * windows should disappear before they enter Pierre's non-cancellable synchronous work queue.
 */
export const MOUNTED_HIGHLIGHT_DWELL_MS = 32;
/** Keep syntax behind a short quiet window while the reviewer is moving the viewport. */
export const MOUNTED_HIGHLIGHT_INTERACTION_QUIET_MS = 80;
/** Pierre serializes CPU rendering, so a second active request would only create stale backlog. */
export const MAX_ACTIVE_MOUNTED_HIGHLIGHTS = 1;

type MountedHighlightListener = (highlighted: HighlightedDiffCode) => void;
type MountedHighlightRequest = {
  cacheKey: string;
  file: DiffFile;
  theme: AppTheme;
  hunkIndex: number | undefined;
  eligibleAt: number;
  state: "dwelling" | "eligible" | "active";
  listeners: Set<MountedHighlightListener>;
};

/**
 * Requests waiting for their dwell remain cancellable and are retained only while a hook is
 * mounted. A single shared wake-up avoids creating one timer closure for every hunk in the
 * bootstrap window; the eligible Set likewise lets unmount remove queued work immediately.
 */
const MOUNTED_HIGHLIGHT_REQUESTS = new Map<string, MountedHighlightRequest>();
const ELIGIBLE_MOUNTED_HIGHLIGHTS = new Set<string>();
let mountedHighlightWakeTimer: ReturnType<typeof setTimeout> | null = null;
let mountedHighlightWakeAt = 0;
let mountedHighlightNotBefore = 0;
let activeMountedHighlightCount = 0;
let mountedHighlightSchedulerCompletionCount = 0;
const mountedHighlightIdleWaiters = new Set<() => void>();

function notifyMountedHighlightIdle() {
  if (
    activeMountedHighlightCount !== 0 ||
    MOUNTED_HIGHLIGHT_REQUESTS.size !== 0 ||
    ELIGIBLE_MOUNTED_HIGHLIGHTS.size !== 0
  ) {
    return;
  }
  for (const resolve of mountedHighlightIdleWaiters) resolve();
  mountedHighlightIdleWaiters.clear();
}

/**
 * Exact identity for one immutable parsed-content generation.
 *
 * Sampling patch text is not a generation check: an equal-length edit outside
 * the sampled windows can otherwise reuse HAST whose spans still contain the
 * previous code. Pierre consumes the parsed metadata plus language, while
 * presentation-only enrichment (such as moved-line kinds) may clone DiffFile
 * around that same metadata. Metadata identity therefore distinguishes real
 * content replacements without throwing away syntax for a move-only clone.
 * The WeakMap does not retain old metadata; highlighted results remain bounded
 * by HighlightedDiffCache's LRU.
 */
function fileContentGenerationId(file: DiffFile) {
  const existing = FILE_CONTENT_GENERATION_IDS.get(file.metadata);
  if (existing !== undefined) {
    return existing;
  }

  const generation = nextFileContentGenerationId;
  nextFileContentGenerationId += 1;
  FILE_CONTENT_GENERATION_IDS.set(file.metadata, generation);
  return generation;
}

/** Full-source metadata cannot be highlighted more narrowly than the complete file. */
function scopedHunkIndex(file: DiffFile, hunkIndex: number | undefined) {
  return file.metadata.isPartial ? hunkIndex : undefined;
}

/** Cache key scoped to one exact immutable file generation and its real highlight grain. */
function buildCacheKey(theme: AppTheme, file: DiffFile, hunkIndex?: number) {
  const scopedHunk = scopedHunkIndex(file, hunkIndex);
  const scope = scopedHunk === undefined ? "file" : `hunk:${scopedHunk}`;
  return `${theme.id}:${theme.syntaxTheme ?? theme.appearance}:${file.id}:language:${file.language ?? ""}:${scope}:generation:${fileContentGenerationId(file)}`;
}

/**
 * A complete file result is a valid presentation source for each of its partial hunk views.
 * Prefer the smaller exact entry, then reuse explicit whole-file prefetch instead of rendering the
 * same hunk again under a second key.
 */
function reusableCachedHighlight(
  file: DiffFile,
  theme: AppTheme,
  cacheKey: string,
) {
  const exact = SHARED_HIGHLIGHTED_DIFF_CACHE.get(cacheKey);
  if (exact) return exact;

  const fileCacheKey = buildCacheKey(theme, file);
  return fileCacheKey === cacheKey ? undefined : SHARED_HIGHLIGHTED_DIFF_CACHE.get(fileCacheKey);
}

/** Share a whole-file prefetch already in flight with a mounted partial hunk. */
function reusableHighlightPromise(
  file: DiffFile,
  theme: AppTheme,
  cacheKey: string,
) {
  const exact = SHARED_HIGHLIGHT_PROMISES.get(cacheKey);
  if (exact) return exact;

  const fileCacheKey = buildCacheKey(theme, file);
  return fileCacheKey === cacheKey ? undefined : SHARED_HIGHLIGHT_PROMISES.get(fileCacheKey);
}

/** Only commit a highlight result if the promise is still the active one for that key.
 *  Prevents a superseded or late-resolving promise from overwriting a newer entry. */
function commitHighlightResult(
  cacheKey: string,
  promise: Promise<HighlightedDiffCode>,
  result: HighlightedDiffCode,
) {
  if (SHARED_HIGHLIGHT_PROMISES.get(cacheKey) !== promise) {
    return false;
  }

  SHARED_HIGHLIGHT_PROMISES.delete(cacheKey);
  SHARED_HIGHLIGHTED_DIFF_CACHE.set(cacheKey, result);
  return true;
}

/** Start one shared highlight request unless the cache or an in-flight promise already has it. */
function ensureHighlightedDiffLoaded(
  file: DiffFile,
  theme: AppTheme,
  cacheKey = buildCacheKey(theme, file),
  hunkIndex?: number,
) {
  const cached = reusableCachedHighlight(file, theme, cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  const existing = reusableHighlightPromise(file, theme, cacheKey);
  if (existing) {
    return existing;
  }

  const requestedHunkIndex = scopedHunkIndex(file, hunkIndex);
  let pending: Promise<HighlightedDiffCode>;
  pending = (requestedHunkIndex === undefined
    ? loadHighlightedDiff(file, theme)
    : loadHighlightedDiffHunk(file, requestedHunkIndex, theme))
    .then((nextHighlighted) => {
      commitHighlightResult(cacheKey, pending, nextHighlighted);
      return nextHighlighted;
    })
    .catch(() => {
      const fallback = {
        deletionLines: [],
        additionLines: [],
      } satisfies HighlightedDiffCode;
      commitHighlightResult(cacheKey, pending, fallback);
      return fallback;
    });

  SHARED_HIGHLIGHT_PROMISES.set(cacheKey, pending);
  return pending;
}

function scheduleMountedHighlightWake() {
  let nextEligibleAt = Number.POSITIVE_INFINITY;
  for (const request of MOUNTED_HIGHLIGHT_REQUESTS.values()) {
    if (request.state === "dwelling") {
      nextEligibleAt = Math.min(nextEligibleAt, request.eligibleAt);
    }
  }

  if (
    ELIGIBLE_MOUNTED_HIGHLIGHTS.size > 0 &&
    activeMountedHighlightCount < MAX_ACTIVE_MOUNTED_HIGHLIGHTS
  ) {
    nextEligibleAt = Math.min(nextEligibleAt, Date.now());
  }

  if (!Number.isFinite(nextEligibleAt)) {
    if (mountedHighlightWakeTimer !== null) {
      clearTimeout(mountedHighlightWakeTimer);
      mountedHighlightWakeTimer = null;
      mountedHighlightWakeAt = 0;
    }
    return;
  }

  const wakeAt = Math.max(nextEligibleAt, mountedHighlightNotBefore);
  if (mountedHighlightWakeTimer !== null && mountedHighlightWakeAt === wakeAt) {
    return;
  }
  if (mountedHighlightWakeTimer !== null) {
    clearTimeout(mountedHighlightWakeTimer);
  }

  mountedHighlightWakeAt = wakeAt;
  mountedHighlightWakeTimer = setTimeout(
    wakeMountedHighlights,
    Math.max(0, wakeAt - Date.now()),
  );
}

function drainMountedHighlights() {
  if (Date.now() < mountedHighlightNotBefore) {
    scheduleMountedHighlightWake();
    return;
  }

  while (activeMountedHighlightCount < MAX_ACTIVE_MOUNTED_HIGHLIGHTS) {
    const nextCacheKey = ELIGIBLE_MOUNTED_HIGHLIGHTS.values().next().value as string | undefined;
    if (nextCacheKey === undefined) {
      return;
    }

    ELIGIBLE_MOUNTED_HIGHLIGHTS.delete(nextCacheKey);
    const request = MOUNTED_HIGHLIGHT_REQUESTS.get(nextCacheKey);
    if (!request || request.state !== "eligible" || request.listeners.size === 0) {
      if (request && request.state !== "active") {
        MOUNTED_HIGHLIGHT_REQUESTS.delete(nextCacheKey);
      }
      notifyMountedHighlightIdle();
      continue;
    }

    request.state = "active";
    activeMountedHighlightCount += 1;
    void ensureHighlightedDiffLoaded(
      request.file,
      request.theme,
      request.cacheKey,
      request.hunkIndex,
    )
      .then((nextHighlighted) => {
        for (const listener of request.listeners) {
          listener(nextHighlighted);
        }
      })
      .finally(() => {
        mountedHighlightSchedulerCompletionCount += 1;
        activeMountedHighlightCount -= 1;
        if (MOUNTED_HIGHLIGHT_REQUESTS.get(request.cacheKey) === request) {
          MOUNTED_HIGHLIGHT_REQUESTS.delete(request.cacheKey);
        }
        drainMountedHighlights();
        scheduleMountedHighlightWake();
        notifyMountedHighlightIdle();
      });
  }
}

function wakeMountedHighlights() {
  mountedHighlightWakeTimer = null;
  mountedHighlightWakeAt = 0;
  const now = Date.now();

  if (now < mountedHighlightNotBefore) {
    scheduleMountedHighlightWake();
    return;
  }

  for (const request of MOUNTED_HIGHLIGHT_REQUESTS.values()) {
    if (request.state !== "dwelling" || request.eligibleAt > now) {
      continue;
    }

    if (request.listeners.size === 0) {
      MOUNTED_HIGHLIGHT_REQUESTS.delete(request.cacheKey);
      notifyMountedHighlightIdle();
      continue;
    }

    request.state = "eligible";
    ELIGIBLE_MOUNTED_HIGHLIGHTS.add(request.cacheKey);
  }

  drainMountedHighlights();
  scheduleMountedHighlightWake();
}

/**
 * Give input and its destination frame priority over background syntax work.
 * Existing cache hits never enter this scheduler, and explicit prefetch bypasses
 * it, so only not-yet-started mounted work waits for the quiet window.
 */
export function deferMountedDiffHighlightsForInteraction() {
  mountedHighlightNotBefore = Math.max(
    mountedHighlightNotBefore,
    Date.now() + MOUNTED_HIGHLIGHT_INTERACTION_QUIET_MS,
  );
  scheduleMountedHighlightWake();
}

/** Resolve after mounted syntax demand, including any already-started job, has fully drained. */
export function waitForMountedDiffHighlightsIdle() {
  if (
    activeMountedHighlightCount === 0 &&
    MOUNTED_HIGHLIGHT_REQUESTS.size === 0 &&
    ELIGIBLE_MOUNTED_HIGHLIGHTS.size === 0
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => mountedHighlightIdleWaiters.add(resolve));
}

/**
 * Lifetime count of mounted scheduler requests that reached a terminal state.
 * Cache hits and explicit prefetch bypass this counter. It is observable proof
 * that scheduler work completed, not proof that every viewport visit produced
 * a unique request or a styled UI commit.
 */
export function readMountedDiffHighlightSchedulerCompletionCount() {
  return mountedHighlightSchedulerCompletionCount;
}

/** Internal deterministic reset for the scheduler's lifecycle tests. */
export function resetMountedHighlightSchedulerForTests() {
  if (mountedHighlightWakeTimer !== null) clearTimeout(mountedHighlightWakeTimer);
  mountedHighlightWakeTimer = null;
  mountedHighlightWakeAt = 0;
  mountedHighlightNotBefore = 0;
  activeMountedHighlightCount = 0;
  MOUNTED_HIGHLIGHT_REQUESTS.clear();
  ELIGIBLE_MOUNTED_HIGHLIGHTS.clear();
  for (const resolve of mountedHighlightIdleWaiters) resolve();
  mountedHighlightIdleWaiters.clear();
}

/**
 * Schedule syntax work owned by mounted diff rows.
 *
 * This is exported from the internal module for deterministic lifecycle tests; it is intentionally
 * absent from the package barrel. Explicit prefetch uses ensureHighlightedDiffLoaded directly and
 * therefore remains immediate.
 */
export function scheduleMountedHighlight({
  file,
  theme,
  hunkIndex,
  onHighlighted,
}: {
  file: DiffFile;
  theme: AppTheme;
  hunkIndex?: number;
  onHighlighted: MountedHighlightListener;
}) {
  const requestedHunkIndex = scopedHunkIndex(file, hunkIndex);
  const cacheKey = buildCacheKey(theme, file, requestedHunkIndex);
  const cached = reusableCachedHighlight(file, theme, cacheKey);
  if (cached) {
    onHighlighted(cached);
    return () => undefined;
  }

  let request = MOUNTED_HIGHLIGHT_REQUESTS.get(cacheKey);
  if (!request) {
    request = {
      cacheKey,
      file,
      theme,
      hunkIndex: requestedHunkIndex,
      eligibleAt: Date.now() + MOUNTED_HIGHLIGHT_DWELL_MS,
      state: "dwelling",
      listeners: new Set(),
    };
    MOUNTED_HIGHLIGHT_REQUESTS.set(cacheKey, request);
    scheduleMountedHighlightWake();
  }

  request.listeners.add(onHighlighted);
  let subscribed = true;

  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    request.listeners.delete(onHighlighted);

    if (request.listeners.size > 0 || request.state === "active") {
      return;
    }

    ELIGIBLE_MOUNTED_HIGHLIGHTS.delete(cacheKey);
    if (MOUNTED_HIGHLIGHT_REQUESTS.get(cacheKey) === request) {
      MOUNTED_HIGHLIGHT_REQUESTS.delete(cacheKey);
    }
    notifyMountedHighlightIdle();
  };
}

/** Queue syntax highlighting for one file without mounting its diff rows first. */
export function prefetchHighlightedDiff({ file, theme }: { file: DiffFile; theme: AppTheme }) {
  return ensureHighlightedDiffLoaded(file, theme);
}

/** Read the best already-available highlight result without starting async work during render. */
function resolveHighlightedSnapshot({
  appearanceCacheKey,
  file,
  theme,
  highlighted,
  highlightedCacheKey,
}: {
  appearanceCacheKey: string | null;
  file: DiffFile | undefined;
  theme: AppTheme;
  highlighted: HighlightedDiffCode | null;
  highlightedCacheKey: string | null;
}) {
  if (!appearanceCacheKey) {
    return null;
  }

  if (highlightedCacheKey === appearanceCacheKey) {
    return highlighted;
  }

  return file
    ? (reusableCachedHighlight(file, theme, appearanceCacheKey) ?? null)
    : null;
}

/** Resolve highlighted diff content with shared caching and background prefetch support. */
export function useHighlightedDiff({
  file,
  hunkIndex,
  theme,
  shouldLoadHighlight,
}: {
  file: DiffFile | undefined;
  /** Limit synchronous syntax work to the mounted hunk when rendering a parsed patch. */
  hunkIndex?: number;
  theme: AppTheme;
  shouldLoadHighlight?: boolean;
}) {
  const [highlighted, setHighlighted] = useState<HighlightedDiffCode | null>(null);
  const [highlightedCacheKey, setHighlightedCacheKey] = useState<string | null>(null);
  const appearanceCacheKey = file ? buildCacheKey(theme, file, hunkIndex) : null;

  // Use a layout effect so a newly available cached result can replace the plain-text fallback
  // before the next diff paint whenever possible. That reduces flash/stutter as files enter view.
  useLayoutEffect(() => {
    if (!file || !appearanceCacheKey) {
      setHighlighted(null);
      setHighlightedCacheKey(null);
      return;
    }

    if (highlightedCacheKey === appearanceCacheKey) {
      return;
    }

    const cached = reusableCachedHighlight(file, theme, appearanceCacheKey);
    if (cached) {
      setHighlighted(cached);
      setHighlightedCacheKey(appearanceCacheKey);
      return;
    }

    if (!shouldLoadHighlight) {
      return;
    }

    setHighlighted(null);

    return scheduleMountedHighlight({
      file,
      theme,
      ...(hunkIndex !== undefined ? { hunkIndex } : {}),
      onHighlighted: (nextHighlighted) => {
        setHighlighted(nextHighlighted);
        setHighlightedCacheKey(appearanceCacheKey);
      },
    });
  }, [appearanceCacheKey, file, highlightedCacheKey, hunkIndex, shouldLoadHighlight, theme]);

  // Prefer cached highlights during render so revisiting a file can paint immediately.
  return resolveHighlightedSnapshot({
    appearanceCacheKey,
    file,
    theme,
    highlighted,
    highlightedCacheKey,
  });
}
