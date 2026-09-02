import type { AgentState } from '../../data/types';
import { useCockpitTheme } from '../ThemeProvider';
import { sparkCells } from '../layout';

/** A colored block sparkline: faint baseline, state color, bright glow endpoint. */
export function Sparkline({
  buckets,
  width,
  state,
}: {
  buckets: readonly number[];
  width: number;
  state: AgentState;
}) {
  const { COLOR, COLOR_HI, FAINT } = useCockpitTheme();
  const cells = sparkCells(buckets, width);
  const on = COLOR[state];
  const glow = COLOR_HI[state];
  return (
    <box flexDirection="row">
      {cells.map((cell, i) => (
        <text key={i} fg={cell.state === 'off' ? FAINT : cell.state === 'glow' ? glow : on}>
          {cell.char}
        </text>
      ))}
    </box>
  );
}
