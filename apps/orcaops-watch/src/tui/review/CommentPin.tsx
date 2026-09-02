// The comment pin.
//
// It renders EXACTLY four rows — border, byline, body, border — because
// `checkpointLayout` prices it at `PIN_HEIGHT = 4`. That is a contract, not a
// coincidence: a fifth row here and every hunk below this pin is measured one
// row short, so `z` scrolls to the wrong line and a windowed hunk's spacers
// stop adding up. The body is deliberately the FIRST LINE only.
//
// `DiffPin.target` is pure geometry, shared verbatim with the layout that prices
// it; the display facts (`endLine`, `spansSlices`) sit on the pin itself. A target
// that means one thing to the measurer and another to the renderer is precisely
// how the two drift.

import type { DiffPin } from './diffPins';
import { useCockpitTheme } from '../ThemeProvider';
import { useHit } from '../kit';

/** Open is loud, resolved is quiet. */
const STATUS_COLOR: Record<string, 'AMBER' | 'LIVE'> = { open: 'AMBER', resolved: 'LIVE' };

export function CommentPin({
  pin,
  width,
  onActivate,
}: {
  pin: DiffPin;
  width: number;
  onActivate?: (commentId: string) => void;
}) {
  const theme = useCockpitTheme();
  const { AMBER, CYAN, DIMMER, FG, SEL_BG } = theme;
  const hit = useHit({
    hitId: `review-comment-pin-${pin.commentId}`,
    enabled: onActivate !== undefined,
    onSelect: onActivate === undefined ? undefined : () => onActivate(pin.commentId),
  });
  const statusColor = theme[STATUS_COLOR[pin.status] ?? 'AMBER'];

  // A range anchor labels its span; the pin still hangs off the primary line's row.
  const span = pin.endLine !== null && pin.line !== null ? ` · L${pin.line}–L${pin.endLine}` : '';

  return (
    <box
      id={`review-comment-pin-${pin.commentId}`}
      flexDirection="column"
      border
      borderColor={CYAN}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={hit.hovered ? SEL_BG : undefined}
      onMouseOver={onActivate === undefined ? undefined : hit.onMouseOver}
      onMouseOut={onActivate === undefined ? undefined : hit.onMouseOut}
      onMouseDown={onActivate === undefined ? undefined : hit.onMouseDown}
      onMouseUp={onActivate === undefined ? undefined : hit.onMouseUp}
    >
      <text fg={CYAN}>
        ✎ {pin.author} · <span fg={statusColor}>{pin.status}</span>
        {pin.replyCount > 0 ? ` · ↳ ${pin.replyCount}` : ''}
        {span}
        {pin.target.kind === 'slice' ? <span fg={DIMMER}> · hunk-grain</span> : null}
        {pin.drifted ? <span fg={AMBER}> · anchor drifted</span> : null}
      </text>
      <text fg={FG}>{firstLine(pin.body, Math.max(8, width - 4))}</text>
    </box>
  );
}

/**
 * The pin above the diff for a comment this page cannot place in a card — the
 * ladder fell to `unanchored`, or it re-anchored into a file this checkpoint
 * never touched. It says WHERE it went, so a reviewer can tell "resolved
 * elsewhere" from "lost".
 */
export function OffPageCommentPin({
  pin,
  width,
  onActivate,
}: {
  pin: DiffPin;
  width: number;
  onActivate?: (commentId: string) => void;
}) {
  const { AMBER, DIMMER, SEL_BG } = useCockpitTheme();
  const hit = useHit({
    hitId: `review-off-page-comment-${pin.commentId}`,
    enabled: onActivate !== undefined,
    onSelect: onActivate === undefined ? undefined : () => onActivate(pin.commentId),
  });
  const where = pin.rung === 'unanchored' ? 'unanchored' : `re-anchored · ${pin.rung}`;
  return (
    <text
      id={`review-off-page-comment-${pin.commentId}`}
      fg={pin.drifted ? AMBER : DIMMER}
      bg={hit.hovered ? SEL_BG : undefined}
      onMouseOver={onActivate === undefined ? undefined : hit.onMouseOver}
      onMouseOut={onActivate === undefined ? undefined : hit.onMouseOut}
      onMouseDown={onActivate === undefined ? undefined : hit.onMouseDown}
      onMouseUp={onActivate === undefined ? undefined : hit.onMouseUp}
    >
      {firstLine(`✎ ${pin.author} · ${pin.status} · ${where} — ${pin.body}`, Math.max(8, width))}
    </text>
  );
}

function firstLine(body: string, width: number): string {
  const line = body.split('\n')[0] ?? '';
  return line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`;
}
