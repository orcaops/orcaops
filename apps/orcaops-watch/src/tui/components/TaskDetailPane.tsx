import { ago, fmtTokens } from '../../core/format';
import type { WatchTask, WatchThread } from '../../data/types';
import { useCockpitTheme } from '../ThemeProvider';
import type { TaskDetailModel, TaskMemberPresentation } from '../detail';
import { EmptyState, Rule, useHit } from '../kit';
import { displayLen, truncate } from '../layout';
import type { ScrollRef } from '../scroll';
import { GLYPH, STATE_LABEL, UI_GLYPH } from '../theme';

function taskSessionTokens(task: WatchTask): { tokens: number; sessions: number } {
  const sessions = new Map<string, number>();
  for (const thread of task.threads) {
    for (const session of thread.sessions) {
      const key = `${session.agent}:${session.session_id}`;
      sessions.set(key, Math.max(sessions.get(key) ?? 0, session.tokens));
    }
  }
  return {
    tokens: [...sessions.values()].reduce((total, tokens) => total + tokens, 0),
    sessions: sessions.size,
  };
}

/**
 * Member-card metrics with a defined narrow-width collapse order: comments
 * drop first, then the open-checkpoint suffix, and below the card minimum the
 * metrics yield the row to the location text entirely.
 */
function memberMetrics(thread: WatchThread, width: number): string {
  if (width < 28) return '';
  const steps = thread.steps ? `${thread.steps.completed}/${thread.steps.total}` : 'no plan';
  const checkpointCount = Math.max(thread.checkpoints.length, thread.openCheckpoints);
  const openSuffix =
    thread.openCheckpoints > 0 && width >= 40 ? `/${thread.openCheckpoints} open` : '';
  const checkpoints = `${checkpointCount}cp${openSuffix}`;
  const comments = thread.openComments > 0 && width >= 34 ? ` · ✎${thread.openComments}` : '';
  if (width < 46) return `${steps} · ${checkpoints}${comments}`;
  return `${steps} steps · ${checkpoints}${comments}`;
}

/**
 * The header's capture-meta line, built from only the segments that exist —
 * "0 sessions · 0 checkpoints" is noise, not information — and dropped
 * right-to-left of this priority (tokens, then checkpoints, then sessions)
 * when the pane is too narrow. Open comments always survive: they are the one
 * segment that demands action.
 */
function fitCaptureMeta(input: {
  sessions: number;
  tokens: number;
  checkpoints: number;
  openComments: number;
  width: number;
}): string {
  const segments: { text: string; dropPriority: number }[] = [];
  if (input.sessions > 0) {
    segments.push({
      text: `${input.sessions} session${input.sessions === 1 ? '' : 's'}`,
      dropPriority: 3,
    });
  }
  if (input.tokens > 0) {
    segments.push({ text: `${fmtTokens(input.tokens)} session tokens`, dropPriority: 1 });
  }
  if (input.checkpoints > 0) {
    segments.push({
      text: `${input.checkpoints} checkpoint${input.checkpoints === 1 ? '' : 's'}`,
      dropPriority: 2,
    });
  }
  if (input.openComments > 0) {
    segments.push({ text: `✎ ${input.openComments} open`, dropPriority: 4 });
  }
  const kept = [...segments];
  const joined = (): string => kept.map((segment) => segment.text).join(' · ');
  while (kept.length > 1 && displayLen(joined()) > input.width) {
    const next = [...kept].sort((a, b) => a.dropPriority - b.dropPriority)[0]!;
    kept.splice(kept.indexOf(next), 1);
  }
  return joined();
}

function TaskMemberCard({
  member,
  width,
  nowMs,
  selected,
  focused,
  onActivate,
}: {
  member: TaskMemberPresentation;
  width: number;
  nowMs: number;
  selected: boolean;
  focused: boolean;
  onActivate: () => void;
}) {
  const theme = useCockpitTheme();
  const { AMBER, BRIGHT, COLOR, DIM, DIMMER, FOCUS_MARKER, SEL_BG, ACCENT } = theme;
  const { thread } = member;
  const hit = useHit({
    hitId: `watch-task-member:${member.id}`,
    // A committed click is the pointer equivalent of Enter: select the stable
    // member and open it in one action. Hover remains paint-only in useHit.
    onSelect: onActivate,
  });
  const color = COLOR[thread.state];
  const marker = selected ? (focused ? UI_GLYPH.paneFocused : UI_GLYPH.paneBlurred) : ' ';
  const bodyWidth = Math.max(8, width - 2);
  const age = ago(thread.lastWriteMs, nowMs);
  const statePrefix = `${GLYPH[thread.state]} ${STATE_LABEL[thread.state]}  `;
  const openHint = selected ? '  open ›' : '  ›';
  const titleWidth = Math.max(
    3,
    bodyWidth - displayLen(statePrefix) - displayLen(age) - displayLen(openHint)
  );
  const current = thread.currentLine ?? 'No current checkpoint summary';
  const metrics = memberMetrics(thread, bodyWidth);
  const metricsWidth = Math.min(displayLen(metrics), Math.max(3, bodyWidth - 5));
  const metricsText = truncate(metrics, metricsWidth);
  const location = `${thread.isCurrentCheckout ? '● here · ' : ''}${thread.agent} · ${thread.source}`;
  const locationWidth = Math.max(3, bodyWidth - metricsWidth - 2);

  return (
    <box
      id={`watch-task-member:${member.id}`}
      flexDirection="row"
      height={3}
      backgroundColor={selected || hit.hovered ? SEL_BG : undefined}
      onMouseOver={hit.onMouseOver}
      onMouseOut={hit.onMouseOut}
      onMouseDown={hit.onMouseDown}
      onMouseUp={hit.onMouseUp}
    >
      <box width={1} flexShrink={0}>
        <text fg={selected ? (focused ? FOCUS_MARKER : DIMMER) : DIMMER}>{marker}</text>
      </box>
      <box flexDirection="column" width={Math.max(7, width - 1)} paddingLeft={1}>
        <box flexDirection="row" height={1}>
          <text fg={color}>{statePrefix}</text>
          <text fg={BRIGHT}>{truncate(thread.title, titleWidth)}</text>
          <box flexGrow={1} />
          <text fg={DIMMER}>{age}</text>
          <text fg={selected ? BRIGHT : DIMMER}>{openHint}</text>
        </box>
        <box height={1}>
          <text fg={DIM}>{truncate(current, bodyWidth)}</text>
        </box>
        <box flexDirection="row" height={1}>
          <text fg={thread.isCurrentCheckout ? ACCENT : DIMMER}>
            {truncate(location, locationWidth)}
          </text>
          <box flexGrow={1} />
          <text fg={thread.openComments > 0 ? AMBER : DIMMER}>{metricsText}</text>
        </box>
      </box>
    </box>
  );
}

/** The detail pane at task level: roll-up identity plus exact-height structured members. */
export function TaskDetailPane({
  task,
  model,
  width,
  nowMs,
  focused,
  scrollRef,
  selectedRef,
  reviewable,
  onMemberActivate,
  onReview,
}: {
  task: WatchTask;
  model: TaskDetailModel;
  width: number;
  nowMs: number;
  focused: boolean;
  scrollRef: ScrollRef;
  selectedRef: string | null;
  reviewable: boolean;
  onMemberActivate: (ref: string) => void;
  onReview: () => void;
}) {
  const theme = useCockpitTheme();
  const { COLOR, BRIGHT, DIM, DIMMER, SEL_BG, ACCENT } = theme;
  const reviewHit = useHit({ hitId: 'watch-task-review', enabled: reviewable, onSelect: onReview });
  const color = COLOR[task.state];
  const inner = Math.max(12, width - 2);
  const contentWidth = Math.min(112, inner);
  const lastWriteMs = task.threads.reduce<number | null>(
    (latest, thread) =>
      thread.lastWriteMs !== null && (latest === null || thread.lastWriteMs > latest)
        ? thread.lastWriteMs
        : latest,
    null
  );
  const active = task.threads.filter((thread) =>
    ['working', 'starting', 'wrapping', 'quiet'].includes(thread.state)
  ).length;
  const attention = task.threads.filter((thread) =>
    ['stalled', 'ready'].includes(thread.state)
  ).length;
  const openComments = Math.max(0, ...task.threads.map((thread) => thread.openComments));
  const checkpoints = task.threads.reduce(
    (total, thread) => total + Math.max(thread.checkpoints.length, thread.openCheckpoints),
    0
  );
  const session = taskSessionTokens(task);
  const pillLabel = ` ${GLYPH[task.state]} ${STATE_LABEL[task.state]} `;
  const pillWidth = displayLen(pillLabel);
  const summary = `${task.threads.length} thread${task.threads.length === 1 ? '' : 's'} · ${
    active > 0 ? `${active} active · ` : ''
  }${attention > 0 ? `${attention} need attention · ` : ''}${ago(lastWriteMs, nowMs)}`;
  const captureMeta = fitCaptureMeta({
    sessions: session.sessions,
    tokens: session.tokens,
    checkpoints,
    openComments,
    width: contentWidth,
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        height={captureMeta === '' ? 5 : 6}
        flexShrink={0}
      >
        <box flexDirection="row" height={1} width={contentWidth}>
          <text fg={ACCENT}>TASK</text>
          <box flexGrow={1} />
          <box width={pillWidth} flexShrink={0}>
            <text fg={color} bg={SEL_BG}>
              {pillLabel}
            </text>
          </box>
        </box>
        <box height={1} width={contentWidth}>
          <text fg={BRIGHT}>{truncate(`${task.project}/${task.branch}`, contentWidth)}</text>
        </box>
        <box height={1} width={contentWidth}>
          <text fg={DIM}>{truncate(summary, contentWidth)}</text>
        </box>
        {captureMeta === '' ? null : (
          <box height={1} width={contentWidth}>
            <text fg={DIM}>{truncate(captureMeta, contentWidth)}</text>
          </box>
        )}
        <box flexDirection="row" height={1} width={contentWidth}>
          <box
            flexDirection="row"
            backgroundColor={reviewable ? SEL_BG : undefined}
            paddingLeft={1}
            paddingRight={1}
            onMouseOver={reviewable ? reviewHit.onMouseOver : undefined}
            onMouseOut={reviewable ? reviewHit.onMouseOut : undefined}
            onMouseDown={reviewable ? reviewHit.onMouseDown : undefined}
            onMouseUp={reviewable ? reviewHit.onMouseUp : undefined}
          >
            <text fg={reviewable ? ACCENT : DIMMER}>{reviewable ? '▶ ' : '× '}</text>
            <text fg={reviewable ? BRIGHT : DIMMER}>
              {contentWidth < 56 ? 'Review  v' : 'Review branch  v'}
            </text>
          </box>
          <box flexGrow={1} />
          <text fg={focused ? BRIGHT : DIMMER}>
            {truncate('j/k select · Enter open', Math.max(0, contentWidth - 18))}
          </text>
        </box>
        <box height={1} width={contentWidth}>
          <Rule width={contentWidth} />
        </box>
      </box>

      <scrollbox
        id="watch-detail-scroll"
        ref={scrollRef}
        scrollY={true}
        focused={focused}
        flexGrow={1}
        paddingLeft={1}
      >
        <box flexDirection="column" width={contentWidth}>
          <box flexDirection="row" height={1} paddingLeft={1}>
            <text fg={DIMMER}>{`THREADS · ${model.members.length}`}</text>
            <box flexGrow={1} />
            {contentWidth >= 58 ? (
              <text fg={DIMMER}>click opens · j/k select · Enter open</text>
            ) : null}
          </box>
          {model.members.length === 0 ? (
            <EmptyState
              id="watch-task-empty"
              variant="screen"
              title="No threads captured for this task yet"
              message="Captured sessions on this branch will appear here as they are recorded."
            />
          ) : (
            model.members.map((member, at) => (
              <box key={member.id} flexDirection="column">
                {at === 0 ? null : <box height={1} flexShrink={0} />}
                <TaskMemberCard
                  member={member}
                  width={contentWidth}
                  nowMs={nowMs}
                  selected={member.id === selectedRef}
                  focused={focused}
                  onActivate={() => onMemberActivate(member.id)}
                />
              </box>
            ))
          )}
        </box>
      </scrollbox>
    </box>
  );
}
