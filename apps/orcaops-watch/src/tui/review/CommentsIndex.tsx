import type { ScrollBoxRenderable } from '@opentui/core';
import type { RefObject } from 'react';

import type { EnrichedComment } from '../../data/commentsSource';
import { useCockpitTheme } from '../ThemeProvider';
import { EmptyState, useHit } from '../kit';
import { truncate } from '../layout';
import { readableProseWidth } from '../responsiveLayout';
import { UI_GLYPH } from '../theme';

/** Replies shown inline per comment before the "+n more" fold. */
const REPLY_PREVIEW = 3;
/** Body preview lines per comment. */
const BODY_PREVIEW = 2;

function wrapText(text: string, width: number, max: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === max) break;
    }
  }
  if (cur.length > 0 && lines.length < max) lines.push(cur);
  if (lines.length === max && text.replace(/\s+/g, ' ').trim().length > lines.join(' ').length) {
    lines[max - 1] = `${lines[max - 1]!.slice(0, Math.max(1, width - 2))} …`;
  }
  return lines;
}

/** Where the comment renders now, as one compact label. */
export function commentWhereLabel(c: EnrichedComment): string {
  const p = c.position;
  if (p === null) return `${c.anchor.file}:${c.anchor.line} (unresolved)`;
  if (p.rung === 'unchanged_context' && p.file !== null && p.line !== null) {
    return `${p.file}:${p.line} (unchanged context)`;
  }
  if (p.line !== null && p.file !== null) return `${p.file}:${p.line}`;
  if (p.rung === 'hunk' && p.file !== null) return `${p.file} (hunk)`;
  if (p.rung === 'file' && p.file !== null) return `${p.file} (file)`;
  if (p.rung === 'section') return 'section header';
  return 'unanchored';
}

export interface CommentsIndexProps {
  comments: EnrichedComment[];
  openCount: number;
  cursor: number;
  width: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onActivate?: (index: number) => void;
}

function CommentIndexCard({
  comment,
  index,
  selected,
  proseWidth,
  bodyWidth,
  onActivate,
}: {
  comment: EnrichedComment;
  index: number;
  selected: boolean;
  proseWidth: number;
  bodyWidth: number;
  onActivate?: () => void;
}) {
  const { AMBER, BRIGHT, CYAN, DIM, DIMMER, FG, FOCUS_BG, FOCUS_MARKER, LIVE, SEL_BG } =
    useCockpitTheme();
  const hit = useHit({
    hitId: `review-comment-${index}`,
    enabled: onActivate !== undefined,
    onSelect: onActivate,
  });
  const statusColor = comment.status === 'open' ? AMBER : LIVE;
  const drifted = comment.position?.drifted === true;
  return (
    <box
      id={`review-comment-${index}`}
      flexDirection="column"
      backgroundColor={selected ? FOCUS_BG : hit.hovered ? SEL_BG : undefined}
      onMouseOver={onActivate === undefined ? undefined : hit.onMouseOver}
      onMouseOut={onActivate === undefined ? undefined : hit.onMouseOut}
      onMouseDown={onActivate === undefined ? undefined : hit.onMouseDown}
      onMouseUp={onActivate === undefined ? undefined : hit.onMouseUp}
    >
      <text fg={selected ? BRIGHT : CYAN}>
        <span fg={selected ? FOCUS_MARKER : BRIGHT}>
          {selected ? `${UI_GLYPH.rowSelected} ` : '  '}
        </span>
        ✎ {truncate(commentWhereLabel(comment), Math.max(12, proseWidth - 40))} ·{' '}
        <span fg={statusColor}>{comment.status}</span> · {comment.author} ·{' '}
        {comment.ts.slice(0, 16).replace('T', ' ')}
        {drifted ? <span fg={AMBER}> · anchor drifted</span> : null}
      </text>
      {wrapText(comment.body, bodyWidth, BODY_PREVIEW).map((line, lineIndex) => (
        <text key={lineIndex} fg={FG}>
          {'    '}
          {line}
        </text>
      ))}
      {comment.replies.slice(0, REPLY_PREVIEW).map((reply, replyIndex) => (
        <text key={`r${replyIndex}`} fg={DIM}>
          {'    ↳ '}
          {reply.author}
          {reply.checkpoint_ref ? ` (cp${reply.checkpoint_ref.cp})` : ''}:{' '}
          {truncate(reply.body.split('\n')[0] ?? '', Math.max(8, bodyWidth - 12))}
        </text>
      ))}
      {comment.replies.length > REPLY_PREVIEW ? (
        <text
          fg={DIMMER}
        >{`      +${comment.replies.length - REPLY_PREVIEW} more repl${comment.replies.length - REPLY_PREVIEW === 1 ? 'y' : 'ies'}`}</text>
      ) : null}
      {comment.owner !== null ? (
        <text fg={DIMMER}>
          {'    from cp'}
          {comment.owner.cp}
          {comment.owner.label !== null ? ` · ${comment.owner.label}` : ''}
        </text>
      ) : null}
      <text> </text>
    </box>
  );
}

/**
 * The comment index (`C`): every comment on the branch — whatever its anchor's
 * fate — newest last, with its resolved location, thread of replies, owning
 * checkpoint, and status. `y` replies, `x` resolves (keys live in ReviewApp).
 */
export function CommentsIndex({
  comments,
  openCount,
  cursor,
  width,
  scrollRef,
  onActivate,
}: CommentsIndexProps) {
  const { ACCENT } = useCockpitTheme();
  const proseWidth = Math.max(16, readableProseWidth(width, 2));
  const bodyW = Math.max(16, proseWidth - 4);
  if (comments.length === 0) {
    return (
      <EmptyState
        id="review-comments-empty"
        variant="screen"
        title="COMMENTS · No comments yet"
        message="In the diff, press c to comment on the selected hunk or row."
      />
    );
  }
  return (
    <scrollbox ref={scrollRef} scrollY={true} focused={true} flexGrow={1} padding={1}>
      <box id="review-comments-prose" width={proseWidth} flexDirection="column">
        <text fg={ACCENT}>
          COMMENTS · {comments.length} total · {openCount} open
        </text>
        <text> </text>
        {comments.map((comment, index) => (
          <CommentIndexCard
            key={comment.comment_id}
            comment={comment}
            index={index}
            selected={index === cursor}
            proseWidth={proseWidth}
            bodyWidth={bodyW}
            onActivate={onActivate === undefined ? undefined : () => onActivate(index)}
          />
        ))}
      </box>
    </scrollbox>
  );
}
