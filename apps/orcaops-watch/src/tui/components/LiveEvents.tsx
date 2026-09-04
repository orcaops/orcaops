import type { TickerEvent } from '@orcaops/watch-data/ui';

import { useCockpitTheme } from '../ThemeProvider';
import {
  EVENT_FAMILY_THEME,
  type EventFamily,
  eventFamily,
  eventLabel,
} from '../eventPresentation';
import { truncate } from '../layout';
import type { CockpitTheme } from '../theme';
import { fmtLocalTime } from '../time';

/**
 * Family → color for this surface. Classification (type → family) lives
 * entirely in the central mapping; 'other' uses this surface's DIM.
 */
function familyColor(theme: CockpitTheme, family: EventFamily): string {
  return family === 'other' ? theme.DIM : theme[EVENT_FAMILY_THEME[family]];
}

/** The raw event stream, newest first, in a scrollbox. */
export function LiveEvents({ ticker, width }: { ticker: readonly TickerEvent[]; width: number }) {
  const theme = useCockpitTheme();
  const { DIM, DIMMER } = theme;
  return (
    <scrollbox scrollY={true} focused={false}>
      {ticker.slice(0, 60).map((event, i) => (
        <box key={`${event.tsMs}-${i}`} flexDirection="row" paddingLeft={1}>
          <text fg={DIMMER}>{`${fmtLocalTime(event.tsMs)} `}</text>
          <text fg={DIM}>{truncate(event.project, Math.max(4, width - 22))}</text>
          <box flexGrow={1} />
          <text fg={familyColor(theme, eventFamily(event.type))}>
            {truncate(eventLabel(event.type), 22)}
          </text>
        </box>
      ))}
    </scrollbox>
  );
}
