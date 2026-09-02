import type { ReactNode } from 'react';

import { useCockpitTheme } from '../ThemeProvider';
import { useHit } from '../kit';

/**
 * A pointer-activatable row.
 *
 * ONE hit implementation shared by the Brief's two panes and the reader's rails:
 * a row that is clickable must also hover, and a row that is not clickable must
 * do neither. Passing no `onSelect` is how a row declares itself inert — which is
 * exactly what the Brief's group headings do.
 */
export function ReviewHitRow({
  id,
  children,
  onSelect,
  selectedBackground,
  flexDirection = 'row',
  paddingLeft,
}: {
  id: string;
  children: ReactNode;
  onSelect?: () => void;
  selectedBackground?: string;
  flexDirection?: 'row' | 'column';
  paddingLeft?: number;
}) {
  const { SEL_BG } = useCockpitTheme();
  const hit = useHit({ hitId: id, enabled: onSelect !== undefined, onSelect });
  const interactive = onSelect !== undefined;
  return (
    <box
      id={id}
      flexDirection={flexDirection}
      paddingLeft={paddingLeft}
      backgroundColor={selectedBackground ?? (hit.hovered ? SEL_BG : undefined)}
      onMouseOver={interactive ? hit.onMouseOver : undefined}
      onMouseOut={interactive ? hit.onMouseOut : undefined}
      onMouseDown={interactive ? hit.onMouseDown : undefined}
      onMouseUp={interactive ? hit.onMouseUp : undefined}
    >
      {children}
    </box>
  );
}
