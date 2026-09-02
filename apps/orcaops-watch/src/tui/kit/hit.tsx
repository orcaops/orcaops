import type { MouseEvent } from '@opentui/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const DEFAULT_DOUBLE_ACTIVATION_MS = 350;

export interface HitRelease {
  readonly committed: boolean;
  readonly double: boolean;
}

/** One pointer-press owner for a rendered application tree. */
export class HitCoordinator {
  private armedId: string | null = null;
  private lastCommit: { readonly hitId: string; readonly at: number } | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly doubleActivationMs = DEFAULT_DOUBLE_ACTIVATION_MS
  ) {}

  arm(hitId: string, enabled = true): boolean {
    this.armedId = enabled ? hitId : null;
    return enabled;
  }

  release(hitId: string, enabled = true): HitRelease {
    const committed = enabled && this.armedId === hitId;
    this.armedId = null;
    if (!committed) return { committed: false, double: false };

    const at = this.now();
    const double =
      this.lastCommit?.hitId === hitId &&
      at >= this.lastCommit.at &&
      at - this.lastCommit.at <= this.doubleActivationMs;
    // A third rapid click starts a new pair instead of activating twice.
    this.lastCommit = double ? null : { hitId, at };
    return { committed: true, double };
  }

  cancel(hitId?: string): void {
    if (hitId === undefined || this.armedId === hitId) this.armedId = null;
  }

  isArmed(hitId: string): boolean {
    return this.armedId === hitId;
  }
}

const fallbackHitCoordinator = new HitCoordinator();
const HitCoordinatorContext = createContext<HitCoordinator>(fallbackHitCoordinator);

export function HitProvider({
  children,
  now,
  doubleActivationMs = DEFAULT_DOUBLE_ACTIVATION_MS,
}: {
  children: ReactNode;
  now?: () => number;
  doubleActivationMs?: number;
}) {
  const coordinator = useMemo(
    () => new HitCoordinator(now, doubleActivationMs),
    [doubleActivationMs, now]
  );
  return (
    <HitCoordinatorContext.Provider value={coordinator}>{children}</HitCoordinatorContext.Provider>
  );
}

export function useHitCoordinator(): HitCoordinator {
  return useContext(HitCoordinatorContext);
}

export interface HitHandlers {
  readonly hovered: boolean;
  readonly onMouseOver: (event: MouseEvent) => void;
  readonly onMouseOut: (event: MouseEvent) => void;
  readonly onMouseDown: (event: MouseEvent) => void;
  readonly onMouseUp: (event: MouseEvent) => void;
}

/** Geometry-neutral hit behavior to spread onto an existing OpenTUI node. */
export function useHit({
  hitId,
  enabled = true,
  onSelect,
  onDoubleActivate,
  onHoverStart,
  onHoverEnd,
}: {
  hitId: string;
  enabled?: boolean;
  onSelect?: () => void;
  onDoubleActivate?: () => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}): HitHandlers {
  const coordinator = useHitCoordinator();
  const [hovered, setHovered] = useState(false);

  useEffect(
    () => () => {
      coordinator.cancel(hitId);
    },
    [coordinator, hitId]
  );

  useEffect(() => {
    if (enabled) return;
    coordinator.cancel(hitId);
    setHovered(false);
  }, [coordinator, enabled, hitId]);

  const onMouseOver = useCallback(
    (event: MouseEvent): void => {
      event.stopPropagation();
      if (!enabled) return;
      setHovered(true);
      onHoverStart?.();
    },
    [enabled, onHoverStart]
  );
  const onMouseOut = useCallback(
    (event: MouseEvent): void => {
      event.stopPropagation();
      setHovered(false);
      coordinator.cancel(hitId);
      onHoverEnd?.();
    },
    [coordinator, hitId, onHoverEnd]
  );
  const onMouseDown = useCallback(
    (event: MouseEvent): void => {
      event.stopPropagation();
      coordinator.arm(hitId, enabled);
    },
    [coordinator, enabled, hitId]
  );
  const onMouseUp = useCallback(
    (event: MouseEvent): void => {
      event.stopPropagation();
      const release = coordinator.release(hitId, enabled);
      if (!release.committed) return;
      onSelect?.();
      if (release.double) onDoubleActivate?.();
    },
    [coordinator, enabled, hitId, onDoubleActivate, onSelect]
  );

  return { hovered, onMouseOver, onMouseOut, onMouseDown, onMouseUp };
}
