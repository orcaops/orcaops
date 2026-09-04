import type { WatchTask, WatchThread } from '@orcaops/watch-data/ui';

import { ago } from '../../core/format';
import { useCockpitTheme } from '../ThemeProvider';
import { SYMBOL } from '../coreTheme';
import { Badge, MeterBar, Row, type RowTone } from '../kit';
import { displayLen, truncate } from '../layout';
import type { ScrollRef } from '../scroll';
import { GLYPH, STATE_LABEL, UI_GLYPH } from '../theme';
import type { RailGroup } from '../viewModel';
import { Sparkline } from './bits';

function rowTone(state: WatchThread['state']): RowTone {
  return state === 'stalled' ? 'stalled' : state === 'ready' ? 'ready' : 'default';
}

function GroupHeader({ group, width }: { group: RailGroup; width: number }) {
  const { AMBER, BRIGHT, DIMMER } = useCockpitTheme();
  const right =
    group.tone === 'attention'
      ? `${group.count} pinned`
      : `${group.count} ${group.count === 1 ? 'thread' : 'threads'}`;
  const titleWidth = Math.max(3, width - 4 - displayLen(right));
  return (
    <box flexDirection="row" height={2} paddingLeft={2} paddingRight={1} paddingTop={1}>
      {group.tone === 'attention' ? (
        <text fg={AMBER}>{truncate(`${UI_GLYPH.attention} ${group.title}`, titleWidth)}</text>
      ) : (
        <text fg={BRIGHT}>{truncate(group.title, titleWidth)}</text>
      )}
      <box flexGrow={1} />
      <text fg={DIMMER}>{right}</text>
    </box>
  );
}

function ThreadRow({
  thread,
  project,
  attention,
  selected,
  focused,
  width,
  nowMs,
  onSelect,
}: {
  thread: WatchThread;
  project: string;
  attention: boolean;
  selected: boolean;
  focused: boolean;
  width: number;
  nowMs: number;
  onSelect: (id: string) => void;
}) {
  const theme = useCockpitTheme();
  const { COLOR, BRIGHT, DIM, DIMMER, FAINT, AMBER } = theme;
  const color = COLOR[thread.state];
  const showStripe = attention || selected;
  // Content width after the 1-col stripe + 1-col left/right padding.
  const inner = Math.max(12, width - 3);

  // Line 1: glyph + state + project/branch ....... ago. Budget the identity
  // so it can never overflow and wrap onto line 2.
  const age = ago(thread.lastWriteMs, nowMs);
  const statePrefix = `${GLYPH[thread.state]} ${STATE_LABEL[thread.state]}  `;
  const idBudget = Math.max(6, inner - displayLen(statePrefix) - displayLen(age));
  const projW = Math.max(3, Math.floor(idBudget * 0.5));
  const branchW = Math.max(3, idBudget - projW - 1);

  const summary = thread.currentLine ?? thread.title;
  // Open review comments surface loud on the row (`✎ n`), stealing summary width.
  const commentBadge = thread.openComments > 0 ? `✎ ${thread.openComments} ` : '';

  return (
    <Row
      id={`watch-thread-row-${thread.artifactId}`}
      height={2}
      selected={selected}
      focused={focused}
      tone={rowTone(thread.state)}
      marker={attention ? SYMBOL.warning : undefined}
      markerColor={attention && !selected ? AMBER : undefined}
      markerBackground={showStripe ? color : undefined}
      onActivate={() => onSelect(thread.artifactId)}
    >
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" height={1}>
          <text fg={color}>{statePrefix}</text>
          <text fg={BRIGHT}>{truncate(project, projW)}</text>
          <text fg={DIM}>{`/${truncate(thread.branch, branchW)}`}</text>
          <box flexGrow={1} />
          <text fg={DIMMER}>{age}</text>
        </box>
        <box flexDirection="row" height={1}>
          <text fg={DIM}>{truncate(summary, Math.max(6, inner - 15 - commentBadge.length))}</text>
          <box flexGrow={1} />
          {commentBadge.length > 0 ? <Badge tone="attention">{commentBadge}</Badge> : null}
          <Sparkline buckets={thread.sparkline} width={5} state={thread.state} />
          <text fg={FAINT}> </text>
          <MeterBar
            completed={thread.steps?.completed ?? 0}
            total={thread.steps?.total ?? 0}
            width={7}
            state={thread.state}
          />
        </box>
      </box>
    </Row>
  );
}

/** A task aggregate row: ⧉ marker + rolled-up state + project/branch + thread count. */
function TaskRow({
  task,
  selected,
  focused,
  width,
  nowMs,
  onSelect,
}: {
  task: WatchTask;
  selected: boolean;
  focused: boolean;
  width: number;
  nowMs: number;
  onSelect: (id: string) => void;
}) {
  const theme = useCockpitTheme();
  const { COLOR, BRIGHT, DIM, DIMMER, ACCENT } = theme;
  const color = COLOR[task.state];
  const inner = Math.max(12, width - 3);
  const count = task.threads.length;
  // Representative member: the most recently active thread on the branch.
  const newest = task.threads.reduce((a, b) =>
    (b.lastWriteMs ?? Number.NEGATIVE_INFINITY) > (a.lastWriteMs ?? Number.NEGATIVE_INFINITY)
      ? b
      : a
  );
  const age = ago(newest.lastWriteMs, nowMs);
  const statePrefix = `⧉ ${GLYPH[task.state]} ${STATE_LABEL[task.state]}  `;
  const idBudget = Math.max(6, inner - displayLen(statePrefix) - displayLen(age));
  const projW = Math.max(3, Math.floor(idBudget * 0.5));
  const branchW = Math.max(3, idBudget - projW - 1);
  const summary = newest.currentLine ?? newest.title;

  return (
    <Row
      id={`watch-task-row-${task.id}`}
      height={2}
      selected={selected}
      focused={focused}
      tone={rowTone(task.state)}
      markerBackground={selected ? color : undefined}
      onActivate={() => onSelect(task.id)}
    >
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" height={1}>
          <text fg={ACCENT}>{statePrefix.slice(0, 2)}</text>
          <text fg={color}>{statePrefix.slice(2)}</text>
          <text fg={BRIGHT}>{truncate(task.project, projW)}</text>
          <text fg={DIM}>{`/${truncate(task.branch, branchW)}`}</text>
          <box flexGrow={1} />
          <text fg={DIMMER}>{age}</text>
        </box>
        <box flexDirection="row" height={1}>
          <text fg={DIM}>
            {truncate(summary, Math.max(6, inner - displayLen(`${count} threads`) - 1))}
          </text>
          <box flexGrow={1} />
          <text fg={ACCENT}>{`${count} thread${count === 1 ? '' : 's'}`}</text>
        </box>
      </box>
    </Row>
  );
}

/** The grouped thread list (attention pinned), in a scrollbox. */
export function ThreadRail({
  groups,
  selectedId,
  width,
  nowMs,
  focused,
  scrollRef,
  onSelect,
}: {
  groups: readonly RailGroup[];
  selectedId: string | null;
  width: number;
  nowMs: number;
  focused: boolean;
  scrollRef: ScrollRef;
  onSelect: (id: string) => void;
}) {
  return (
    <scrollbox id="watch-rail-scroll" ref={scrollRef} scrollY={true} focused={focused}>
      {groups.map((group) => (
        <box key={group.key} flexDirection="column">
          <GroupHeader group={group} width={width} />
          {group.rows.map((row) =>
            row.kind === 'thread' ? (
              <ThreadRow
                key={row.id}
                thread={row.thread}
                project={row.project}
                attention={group.tone === 'attention'}
                selected={row.id === selectedId}
                focused={focused}
                width={width}
                nowMs={nowMs}
                onSelect={onSelect}
              />
            ) : (
              <TaskRow
                key={row.id}
                task={row.task}
                selected={row.id === selectedId}
                focused={focused}
                width={width}
                nowMs={nowMs}
                onSelect={onSelect}
              />
            )
          )}
        </box>
      ))}
    </scrollbox>
  );
}
