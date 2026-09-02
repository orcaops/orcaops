/**
 * Mount the real `ReviewApp` into an OpenTUI test renderer and read back the
 * frame the user would actually see.
 *
 * This is the falsifiability floor. Every assertion built on top of it observes
 * one of two things: characters in the rendered frame, or a durable effect the
 * app appended. Never an emitted controller command — a command is an intention,
 * and the regression this suite exists to catch is intentions that render wrong.
 *
 * Requires Bun: @opentui/core loads `bun:`-protocol modules, which is why the
 * Vitest config stubs it out and why these tests run under `bun test` instead.
 */
import { createTestRenderer, type MockInput, type MockMouse } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { useState } from 'react';

import { buildReviewAppHarness, type ReviewAppHarness } from './reviewAppHarness';
import type { WatchReviewFixtureScenario } from './reviewExperienceFixtures';
import type { EnrichedComment } from '../../src/data/commentsSource';
import { ThemeProvider } from '../../src/tui/ThemeProvider';
import {
  ReviewApp,
  type ReviewAppProps,
  type ReviewShellRequest,
} from '../../src/tui/review/ReviewApp';
import type { StoryReviewScreen } from '../../src/tui/review/keymap';
import type { ReviewControllerState } from '../../src/tui/review/readerReviewController';

type StdoutListener = (chunk: string) => void;
const stdoutListeners = new Map<symbol, StdoutListener>();
let stdoutBaseWrite: typeof process.stdout.write | null = null;
let stdoutHarnessWrite: typeof process.stdout.write | null = null;

/** One process-wide stdout wrapper shared by every concurrently mounted harness. */
function acquireStdoutListener(listener: StdoutListener): () => void {
  const token = Symbol('mounted-review-stdout');
  stdoutListeners.set(token, listener);
  if (stdoutHarnessWrite === null) {
    stdoutBaseWrite = process.stdout.write;
    const base = stdoutBaseWrite.bind(process.stdout);
    stdoutHarnessWrite = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') {
        for (const active of stdoutListeners.values()) active(chunk);
      }
      return (base as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stdout.write = stdoutHarnessWrite;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    stdoutListeners.delete(token);
    if (stdoutListeners.size !== 0) {
      // OpenTUI restores its own stdout hook when any renderer is destroyed.
      // A sibling harness may still own our shared listener, so put the shared
      // wrapper back after that renderer-level cleanup rather than letting an
      // out-of-order unmount silently disable capture for the survivor.
      if (stdoutHarnessWrite !== null && process.stdout.write !== stdoutHarnessWrite) {
        process.stdout.write = stdoutHarnessWrite;
      }
      return;
    }
    if (process.stdout.write === stdoutHarnessWrite && stdoutBaseWrite !== null) {
      process.stdout.write = stdoutBaseWrite;
    }
    stdoutBaseWrite = null;
    stdoutHarnessWrite = null;
  };
}

export function mountedHarnessGlobalLeaseCount(): number {
  return stdoutListeners.size;
}

export interface MountedReviewApp extends ReviewAppHarness {
  /** The frame as characters, exactly as the terminal would show it. */
  frame: () => string;
  /** Frame split into rows, trailing blank columns preserved. */
  rows: () => string[];
  /** Press a key and settle the resulting render. */
  press: (key: string) => Promise<void>;
  /** Press a key and drive only its pending React commit, without frame convergence. */
  pressToCommit: (key: string) => Promise<void>;
  /** Press several keys in order, settling each. */
  pressAll: (keys: readonly string[]) => Promise<void>;
  /** Re-render without input (e.g. after an async effect resolves). */
  settle: () => Promise<void>;
  /**
   * Settle until the frame satisfies `predicate`, or give up.
   *
   * For assertions on ASYNC effects — a gap expansion's source fetch, say. A fixed
   * number of settles is a race: it passes alone and fails in a loaded suite, which
   * is the worst kind of test, because it looks like a real regression.
   */
  settleUntil: (predicate: (frame: string) => boolean, tries?: number) => Promise<boolean>;
  /** Emit one production live-generation change and settle its authoritative reload. */
  liveRefresh: () => Promise<void>;
  /** Latest controller state the app published. */
  state: () => ReviewControllerState;
  /** Request a command through the persistent App-shell bridge. */
  requestShell: (id: ReviewShellRequest['id']) => Promise<void>;
  /** Emulate a higher-priority shell menu/theme layer owning keyboard input. */
  setInputSuspended: (suspended: boolean) => Promise<void>;
  /** Resize both the real test renderer and ReviewApp's controlled terminal props. */
  resize: (width: number, height: number) => Promise<void>;
  /** Commit exactly the resize frame, before timer-driven anchor retries run. */
  resizeOneFrame: (width: number, height: number) => Promise<void>;
  /**
   * Where the diff column's viewport ACTUALLY sits, read off the live renderable.
   * Not a mirror of what the app believes — the renderable's own scroll position,
   * which is the thing a reader's eyes are looking at.
   */
  scrollTop: () => number;
  /** The diff viewport's real geometry, off the live renderable. */
  scrollBounds: () => { viewport: number; content: number; top: number };
  /** The independently scrolling contextual rail's live geometry. */
  railScrollBounds: () => { viewport: number; content: number; top: number };
  /**
   * Text the app actually put on the system clipboard, decoded from the OSC 52
   * escapes it wrote to the terminal.
   *
   * This is what makes `Y` falsifiable: asserting the notice it prints — 'Copied
   * 3 row(s)' — is the app agreeing with itself about a thing it may not have
   * done. The bytes are the effect.
   */
  clipboardWrites: () => string[];
  /** How many times the app asked to exit. */
  exits: () => number;
  /**
   * How many renderables are actually mounted under the diff column.
   *
   * This is how virtualization becomes observable. "Bounded" is not a claim you
   * can read off a frame — the frame only ever shows a viewport's worth — so the
   * only honest way to prove a 5,000-row hunk did not mount 5,000 nodes is to
   * count them.
   */
  diffNodeCount: () => number;
  /**
   * Total live renderables under the mounted application.
   *
   * A screen that stacks many independent CheckpointDiff trees has no canonical
   * diff-scroll surface, so `diffNodeCount` cannot see its work. Counting the
   * entire mounted application is the stricter cap that does.
   */
  mountedNodeCount: () => number;
  /** Geometry and opacity of a tagged production surface. */
  surface: (id: string) => { width: number; height: number; backgroundAlpha: number };
  /** Resolved RGBA background for style assertions where opacity alone is ambiguous. */
  surfaceBackground: (id: string) => readonly [number, number, number, number];
  /** Absolute geometry for pointer journeys that must target a tagged surface. */
  surfaceRect: (id: string) => {
    x: number;
    y: number;
    width: number;
    height: number;
    backgroundAlpha: number;
  };
  mockInput: MockInput;
  mockMouse: MockMouse;
  unmount: () => void;
}

interface ScrollableNode {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  backgroundColor?: { r?: number; g?: number; b?: number; a?: number };
  scrollTop?: number;
  scrollHeight?: number;
  viewport?: { height?: number };
  getChildren?: () => unknown[];
}

function findNode(node: unknown, id: string): ScrollableNode | null {
  const candidate = node as ScrollableNode;
  if (candidate?.id === id) return candidate;
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findNode(child, id);
    if (found !== null) return found;
  }
  return null;
}

/** Depth-first search for the renderable the app tagged as the diff scroll region. */
function findScrollBox(node: unknown, id: string): ScrollableNode | null {
  const candidate = findNode(node, id);
  return candidate !== null && typeof candidate.scrollTop === 'number' ? candidate : null;
}

/** The live geometry of one tagged scroll region. */
function boundsOf(root: unknown, id: string): { viewport: number; content: number; top: number } {
  const box = findScrollBox(root, id);
  return {
    viewport: box?.viewport?.height ?? 0,
    content: box?.scrollHeight ?? 0,
    top: box?.scrollTop ?? 0,
  };
}

/** Every renderable under `node`, itself included. */
function countNodes(node: unknown): number {
  const candidate = node as ScrollableNode;
  let total = 1;
  for (const child of candidate?.getChildren?.() ?? []) total += countNodes(child);
  return total;
}

function backgroundRgbaOf(node: ScrollableNode | null): readonly [number, number, number, number] {
  const color = node?.backgroundColor;
  return [color?.r ?? 0, color?.g ?? 0, color?.b ?? 0, color?.a ?? 0];
}

/**
 * Named keys, mapped to the codes a real terminal sends.
 *
 * `MockInput.pressKey` takes `string | keyof KeyCodes`, and its special names are
 * UPPERCASE — so `pressKey('return')` does not press Enter, it TYPES the six
 * letters r, e, t, u, r, n. That is a silent, plausible-looking lie: the `u`
 * lands on the page-up key, the test asserts a screen that never changed, and the
 * failure reads like a product bug.
 *
 * `press` resolves these first, so both `press('return')` and `press('\r')` press
 * Enter and neither types anything. Typing literal text still goes through
 * `pressAll([...'some text'])`, which is what the note-entry tests use.
 */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  return: '\r',
  enter: '\r',
  escape: '\u001b',
  esc: '\u001b',
  tab: '\t',
  backspace: '\b',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  pageup: '\u001b[5~',
  pagedown: '\u001b[6~',
  'shift-left': '\u001b[1;2D',
  'shift-right': '\u001b[1;2C',
};

function keyCode(key: string): string {
  return NAMED_KEYS[key] ?? key;
}

/** Drive terminal control chords through MockInput's modifier-aware path. */
function pressMockKey(mockInput: MockInput, key: string): void {
  const control = /^C-(.)$/.exec(key);
  if (control?.[1] !== undefined) mockInput.pressKey(control[1], { ctrl: true });
  else mockInput.pressKey(keyCode(key));
}

/**
 * Let React's async reconciliation and the app's load effects run to quiescence
 * before painting. Two macrotask turns is enough for the promise chains the app
 * awaits on mount; the render itself is synchronous once state has settled.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export async function mountReviewApp(options: {
  scenario: WatchReviewFixtureScenario;
  root?: string;
  screen?: StoryReviewScreen;
  width?: number;
  height?: number;
  /** Override the patch under review — see `tallHarnessDiff`. */
  reviewDiff?: string;
  /** The comment sidecar, with positions the engine's ladder already resolved. */
  comments?: readonly EnrichedComment[];
  /** Override only the controller fields relevant to a direct-entry test. */
  controllerState?: Partial<ReviewControllerState>;
  /** Override the routine-Story overlay (e.g. a stale status) on the loaded review. */
  routineStory?: Parameters<typeof buildReviewAppHarness>[0]['routineStory'];
  /** Make the load-time HEAD differ from the floor pin to exercise the TRUST banner. */
  staleFloor?: boolean;
  /** Enable production load/live-refresh effects for mounted seam tests. */
  autoLoad?: boolean;
  /** Start on the true cold path with no previously installed review. */
  startWithoutReview?: boolean;
  reviewLoader?: ReviewAppProps['reviewLoader'];
  installedReviewLoader?: ReviewAppProps['installedReviewLoader'];
  reviewGenerationLoader?: ReviewAppProps['reviewGenerationLoader'];
  worktreeProbeLoader?: ReviewAppProps['worktreeProbeLoader'];
  reviewAuxLoader?: ReviewAppProps['reviewAuxLoader'];
  liveRefreshThrottleMs?: number;
  wheelAccelerationClock?: ReviewAppProps['wheelAccelerationClock'];
  onDiffWheelCommitted?: ReviewAppProps['onDiffWheelCommitted'];
  onLoadingFrameCommitted?: ReviewAppProps['onLoadingFrameCommitted'];
  onControllerStateCommitted?: ReviewAppProps['onControllerStateCommitted'];
  onControllerStateChange?: ReviewAppProps['onControllerStateChange'];
  onCommandExecuted?: ReviewAppProps['onCommandExecuted'];
  onProjectionBuild?: ReviewAppProps['onProjectionBuild'];
  /** Optional production-shaped loaded review for mounted performance/integration harnesses. */
  initialLoadedOverride?: ReviewAppProps['initialLoaded'];
  /** Override the durable journal seam alongside a custom loaded review. */
  journalEffects?: ReviewAppProps['journalEffects'];
  /** Test-only fault injection after global harness hooks are acquired. */
  failAfterHarnessHooks?: boolean;
}): Promise<MountedReviewApp> {
  const width = options.width ?? 110;
  const height = options.height ?? 36;
  const harness = await buildReviewAppHarness({
    scenario: options.scenario,
    root: options.root,
    screen: options.screen,
    ...(options.reviewDiff !== undefined ? { reviewDiff: options.reviewDiff } : {}),
    ...(options.comments !== undefined ? { comments: options.comments } : {}),
    ...(options.controllerState !== undefined ? { controllerState: options.controllerState } : {}),
    ...(options.routineStory !== undefined ? { routineStory: options.routineStory } : {}),
  });

  const {
    renderer,
    mockInput,
    mockMouse,
    renderOnce,
    captureCharFrame,
    resize: resizeRenderer,
  } = await createTestRenderer({
    width,
    height,
    // Kitty encodes Escape as a complete key event rather than an ambiguous
    // byte prefix, so the harness never waits on OpenTUI's parser timeout.
    kittyKeyboard: true,
  });

  // The clipboard is a WRITE TO THE TERMINAL, so that is where we read it back
  // from. `copyViaOsc52` tries the renderer's native call first and falls back to
  // writing the escape to stdout; under the test renderer the native path is not
  // acked, so the fallback is the live one. Either way the bytes pass here.
  const clipboard: string[] = [];
  // OSC 52 is `ESC ] 52 ; c ; <base64> BEL`. Scanned by hand rather than by regex:
  // the pattern would have to contain the literal ESC and BEL bytes, which is
  // exactly what `no-control-regex` exists to catch, and the rule is right — a
  // control character inside a regex is almost always a mistake. Here it is the
  // protocol, so the protocol is spelled out instead.
  const OSC52_OPEN = '\u001b]52;c;';
  const OSC52_CLOSE = '\u0007';
  const scanOsc52 = (chunk: string): void => {
    let at = chunk.indexOf(OSC52_OPEN);
    while (at !== -1) {
      const from = at + OSC52_OPEN.length;
      const to = chunk.indexOf(OSC52_CLOSE, from);
      if (to === -1) return;
      clipboard.push(Buffer.from(chunk.slice(from, to), 'base64').toString('utf8'));
      at = chunk.indexOf(OSC52_OPEN, to);
    }
  };
  const releaseStdout = acquireStdoutListener(scanOsc52);

  // `copyViaOsc52` tries the RENDERER'S native call first and only falls back to
  // stdout when the terminal never acked OSC 52. Spying on stdout alone therefore
  // catches the fallback and misses the path that actually runs here — the copy
  // succeeds, the bytes are real, and the test sees nothing.
  const native = renderer as unknown as { copyToClipboardOSC52?: (text: string) => boolean };
  const realCopy = native.copyToClipboardOSC52;
  if (realCopy !== undefined) {
    native.copyToClipboardOSC52 = (text: string) => {
      const ok = realCopy.call(renderer, text);
      if (ok) clipboard.push(text);
      return ok;
    };
  }
  let hooksReleased = false;
  let mountedRoot: ReturnType<typeof createRoot> | null = null;
  const releaseHooks = (): void => {
    if (hooksReleased) return;
    hooksReleased = true;
    releaseStdout();
    if (realCopy !== undefined) native.copyToClipboardOSC52 = realCopy;
  };
  const destroyAndRelease = (): void => {
    try {
      if (mountedRoot !== null) {
        const rootToUnmount = mountedRoot;
        mountedRoot = null;
        flushSync(() => rootToUnmount.unmount());
      }
    } finally {
      try {
        renderer.destroy();
      } finally {
        releaseHooks();
      }
    }
  };
  if (options.failAfterHarnessHooks) {
    destroyAndRelease();
    throw new Error('mounted harness fault after global hooks');
  }

  let exits = 0;
  let latest: ReviewControllerState = harness.initialState;
  const loadedWithStaleness = options.staleFloor
    ? {
        ...harness.loaded,
        data: {
          ...harness.loaded.data,
          floor: {
            ...harness.loaded.data.floor,
            scope: { ...harness.loaded.data.floor.scope, head_sha: 'floor-head' },
          },
          worktreeHeadSha: 'current-head',
        },
      }
    : harness.loaded;
  const initialLoaded =
    options.initialLoadedOverride !== undefined
      ? options.initialLoadedOverride
      : loadedWithStaleness;
  const root = createRoot(renderer);
  mountedRoot = root;
  let liveGen = 0;
  const reviewGenerationLoader =
    options.reviewGenerationLoader ??
    (async () => ({
      bundle: `mounted-bundle-${liveGen}`,
      story: null,
      storyInstallation: null,
      storyAnchors: null,
      journal: null,
      comments: null,
    }));
  const worktreeProbeLoader =
    options.worktreeProbeLoader ??
    (async () => ({
      headSha: (initialLoaded ?? harness.loaded).data.worktreeHeadSha,
      porcelainDigest: (initialLoaded ?? harness.loaded).data.worktreeDigest,
    }));
  const reviewAuxLoader = async () => ({
    comments: harness.loaded.comments,
  });
  let advanceLiveGeneration: (() => void) | null = null;
  let requestShell: ((id: ReviewShellRequest['id']) => void) | null = null;
  let changeInputSuspended: ((suspended: boolean) => void) | null = null;
  let changeDimensions: ((dimensions: { width: number; height: number }) => void) | null = null;
  const MountedReviewRoot = () => {
    const [renderedLiveGen, setRenderedLiveGen] = useState(liveGen);
    const [renderedShellRequest, setRenderedShellRequest] = useState<ReviewShellRequest | null>(
      null
    );
    const [renderedInputSuspended, setRenderedInputSuspended] = useState(false);
    const [renderedDimensions, setRenderedDimensions] = useState({ width, height });
    advanceLiveGeneration = () => {
      liveGen += 1;
      setRenderedLiveGen(liveGen);
    };
    requestShell = (id) =>
      setRenderedShellRequest((current) => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
    changeInputSuspended = setRenderedInputSuspended;
    changeDimensions = setRenderedDimensions;
    return (
      <ThemeProvider detectedThemeMode={undefined}>
        <ReviewApp
          root={options.root}
          branch="probe"
          width={renderedDimensions.width}
          height={renderedDimensions.height}
          liveGen={renderedLiveGen}
          shellRequest={renderedShellRequest}
          inputSuspended={renderedInputSuspended}
          initialLoaded={options.startWithoutReview ? undefined : initialLoaded}
          initialControllerState={harness.initialState}
          disableAutoLoad={!options.autoLoad}
          reviewLoader={options.reviewLoader}
          installedReviewLoader={options.installedReviewLoader ?? options.reviewLoader}
          reviewGenerationLoader={reviewGenerationLoader}
          worktreeProbeLoader={worktreeProbeLoader}
          liveRefreshThrottleMs={options.liveRefreshThrottleMs}
          wheelAccelerationClock={options.wheelAccelerationClock}
          onDiffWheelCommitted={options.onDiffWheelCommitted}
          onLoadingFrameCommitted={options.onLoadingFrameCommitted}
          onControllerStateCommitted={options.onControllerStateCommitted}
          reviewAuxLoader={options.reviewAuxLoader ?? reviewAuxLoader}
          onExit={() => {
            exits += 1;
          }}
          onCommandExecuted={options.onCommandExecuted}
          onProjectionBuild={options.onProjectionBuild}
          journalEffects={options.journalEffects ?? harness.journalEffects}
          commentEffects={harness.commentEffects}
          onControllerStateChange={(state) => {
            latest = state;
            options.onControllerStateChange?.(state);
          }}
        />
      </ThemeProvider>
    );
  };
  try {
    // OpenTUI's React root is concurrent. Flush the first commit explicitly so
    // the convergence loop never mistakes the unchanged pre-commit shell for a
    // settled application while a large diff subtree is still being reconciled.
    flushSync(() => root.render(<MountedReviewRoot />));
  } catch (error) {
    destroyAndRelease();
    throw error;
  }

  /**
   * Render until the tree stops changing.
   *
   * Two things make a single pass a lie. Layout converges a frame behind its
   * subtree, so geometry read on the first render of a new screen — a scrollbox's
   * viewport height, measured while its parent is still resolving — is stale. And
   * the app REACTS to that geometry: it reads the diff viewport back off the
   * renderable in an effect, and an effect's setState schedules a render rather
   * than performing one, so the mount plan lands a pass later still.
   *
   * A FIXED number of passes is the trap. How many it takes varies with load, so a
   * count tuned on one test passes alone and fails in a full suite — which reads
   * as a product regression and is not one: the same virtualization test can mount
   * 20,041 nodes in a loaded suite and 294 on its own with the code correct both
   * times.
   *
   * Production never sees any of this — its render loop runs continuously, so every
   * key arrives on a converged tree. So converge, rather than guess a pass count.
   */
  const settle = async () => {
    let previous = -1;
    let previousFrame: string | null = null;
    for (let pass = 0; pass < 10; pass += 1) {
      await flush();
      // Input/effects may have queued a concurrent React commit whose node count
      // has not changed yet. Force that work to land before comparing snapshots;
      // equal pre-commit counts are not evidence of convergence.
      flushSync();
      await renderOnce();
      const nodes = countNodes(renderer.root);
      const frame = captureCharFrame();
      // State such as measured file ownership can change text/style without
      // changing host-node cardinality. Node-count-only convergence returns an
      // intermediate frame under load, letting tests and benchmarks sample bootstrap
      // presentation as if it were settled product state.
      if (nodes === previous && frame === previousFrame) return;
      previous = nodes;
      previousFrame = frame;
    }
  };
  try {
    await settle();
  } catch (error) {
    destroyAndRelease();
    throw error;
  }

  return {
    ...harness,
    frame: () => captureCharFrame(),
    rows: () => captureCharFrame().split('\n'),
    press: async (key: string) => {
      pressMockKey(mockInput, key);
      await settle();
    },
    pressToCommit: async (key: string) => {
      pressMockKey(mockInput, key);
      await flush();
      flushSync();
      await renderOnce();
    },
    pressAll: async (keys: readonly string[]) => {
      for (const key of keys) {
        pressMockKey(mockInput, key);
        await settle();
      }
    },
    settle,
    settleUntil: async (predicate: (frame: string) => boolean, tries = 20) => {
      for (let attempt = 0; attempt < tries; attempt += 1) {
        if (predicate(captureCharFrame())) return true;
        await settle();
      }
      return predicate(captureCharFrame());
    },
    liveRefresh: async () => {
      advanceLiveGeneration?.();
      await settle();
    },
    state: () => latest,
    requestShell: async (id) => {
      requestShell?.(id);
      await settle();
    },
    setInputSuspended: async (suspended) => {
      changeInputSuspended?.(suspended);
      await settle();
    },
    resize: async (nextWidth, nextHeight) => {
      resizeRenderer(nextWidth, nextHeight);
      changeDimensions?.({ width: nextWidth, height: nextHeight });
      await settle();
    },
    resizeOneFrame: async (nextWidth, nextHeight) => {
      resizeRenderer(nextWidth, nextHeight);
      flushSync(() => changeDimensions?.({ width: nextWidth, height: nextHeight }));
      await renderOnce();
    },
    scrollTop: () => findScrollBox(renderer.root, 'review-diff-scroll')?.scrollTop ?? 0,
    scrollBounds: () => boundsOf(renderer.root, 'review-diff-scroll'),
    railScrollBounds: () => boundsOf(renderer.root, 'review-context-rail'),
    diffNodeCount: () => {
      const box = findScrollBox(renderer.root, 'review-diff-scroll');
      return box === null ? 0 : countNodes(box);
    },
    mountedNodeCount: () => countNodes(renderer.root),
    surface: (id: string) => {
      const node = findNode(renderer.root, id);
      return {
        width: node?.width ?? 0,
        height: node?.height ?? 0,
        backgroundAlpha: node?.backgroundColor?.a ?? 0,
      };
    },
    surfaceBackground: (id: string) => backgroundRgbaOf(findNode(renderer.root, id)),
    surfaceRect: (id: string) => {
      const node = findNode(renderer.root, id);
      return {
        x: node?.x ?? 0,
        y: node?.y ?? 0,
        width: node?.width ?? 0,
        height: node?.height ?? 0,
        backgroundAlpha: node?.backgroundColor?.a ?? 0,
      };
    },
    clipboardWrites: () => [...clipboard],
    exits: () => exits,
    mockInput,
    mockMouse,
    unmount: () => {
      destroyAndRelease();
    },
  };
}

/**
 * Row index of the first line containing `needle`, or -1. Used to assert
 * geometry (what sits beside what) rather than a label that claims a geometry.
 */
export function rowOf(rows: readonly string[], needle: string): number {
  return rows.findIndex((row) => row.includes(needle));
}
