import { ago, fmtTokens } from '../../core/format';
import { DEFAULT_SPARKLINE } from '../../core/sparkline';
import type { WatchThread } from '../../data/types';
import { useCockpitTheme } from '../ThemeProvider';
import { Rule } from '../kit';
import { truncate } from '../layout';
import { fitActionRow } from '../responsiveLayout';
import { Sparkline } from './bits';

/** Duration formatter for the span sub-label ("4h 41m"), distinct from relative `ago`. */
function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** A 3-row-tall faint vertical rule between vital cells. */
function VDivider() {
  const { FAINT } = useCockpitTheme();
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text fg={FAINT}>│</text>
      <text fg={FAINT}>│</text>
      <text fg={FAINT}>│</text>
    </box>
  );
}

export interface CompactVitalStripLayout {
  parts: readonly { id: string; label: string }[];
  droppedIds: readonly string[];
  requiredDroppedIds: readonly string[];
  occupiedWidth: number;
}

/** One-row vitals retain token and step truth, then add activity if it fits. */
export function selectCompactVitalStripLayout({
  width,
  tokens,
  done,
  total,
  activity,
}: {
  width: number;
  tokens: number;
  done: number;
  total: number;
  activity: string;
}): CompactVitalStripLayout {
  const tokenValue = fmtTokens(tokens);
  const stepValue = total > 0 ? `${done}/${total}` : '—';
  const row = fitActionRow(
    [
      {
        id: 'tokens',
        fullLabel: `session tokens ${tokenValue}`,
        shortLabel: `tok ${tokenValue}`,
        priority: 0,
        required: true,
      },
      {
        id: 'steps',
        fullLabel: total > 0 ? `${stepValue} steps` : 'no plan',
        shortLabel: stepValue,
        priority: 0,
        required: true,
      },
      {
        id: 'activity',
        fullLabel: `last active ${activity}`,
        shortLabel: activity,
        priority: 2,
      },
    ],
    width,
    3
  );
  return {
    parts: row.items.map((item) => ({ id: item.id, label: item.label })),
    droppedIds: row.droppedIds,
    requiredDroppedIds: row.requiredDroppedIds,
    occupiedWidth: row.occupiedWidth,
  };
}

/** STEPS cadence: ● done (green) · ◉ in-progress (violet) · ○ todo (dim hollow). */
function StepDots({ thread, maxDots }: { thread: WatchThread; maxDots: number }) {
  const { DIMMER, FAINT, LIVE, ACCENT } = useCockpitTheme();
  const steps = thread.planSteps;
  if (steps.length === 0) return <text fg={FAINT}>—</text>;
  const shown = steps.slice(0, maxDots);
  const overflow = steps.length - shown.length;
  return (
    <box flexDirection="row">
      {shown.map((s, i) => (
        <box key={i} flexDirection="row">
          {i > 0 ? <text fg={FAINT}>─</text> : null}
          <text fg={s.done ? LIVE : s.current ? ACCENT : DIMMER}>
            {s.done ? '●' : s.current ? '◉' : '○'}
          </text>
        </box>
      ))}
      {overflow > 0 ? <text fg={DIMMER}>{` +${overflow}`}</text> : null}
    </box>
  );
}

/**
 * The pinned stat strip under the detail scroll — SESSION TOKENS │ STEPS │
 * ACTIVITY, three rows each (label+value / viz / sub-label), separated by faint
 * vertical rules. Below ~54 cols it degrades to a single compact line.
 */
export function VitalStrip({
  thread,
  width,
  nowMs,
}: {
  thread: WatchThread;
  width: number;
  nowMs: number;
}) {
  const { BRIGHT, DIM, DIMMER } = useCockpitTheme();
  const inner = Math.max(16, width - 2);
  const tokens = thread.sessions.reduce((total, session) => total + session.tokens, 0);
  const sessions = new Set(
    thread.sessions.map((session) => `${session.agent}:${session.session_id}`)
  ).size;
  const done = thread.planSteps.filter((s) => s.done).length;
  const wip = thread.planSteps.filter((s) => s.current).length;
  const total = thread.planSteps.length;
  const todo = Math.max(0, total - done - wip);

  if (inner < 54) {
    const layout = selectCompactVitalStripLayout({
      width: inner,
      tokens,
      done,
      total,
      activity: ago(thread.lastWriteMs, nowMs),
    });
    return (
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <Rule width={inner} />
        <box flexDirection="row" height={1}>
          {layout.parts.map((part, index) => (
            <box key={part.id} flexDirection="row">
              {index === 0 ? null : <text fg={DIMMER}> · </text>}
              <text fg={part.id === 'tokens' ? BRIGHT : DIMMER}>{part.label}</text>
            </box>
          ))}
        </box>
      </box>
    );
  }

  // Three cells split from the width remaining after two 3-col dividers.
  const cellsW = inner - 6;
  const cellW = Math.floor(cellsW / 3);
  const lastW = cellsW - cellW * 2;
  const sparkW = (w: number): number => Math.max(6, Math.min(18, w - 2));
  const sessionScope =
    thread.startedAtMs !== null
      ? `cumulative · ${fmtSpan(nowMs - thread.startedAtMs)} span`
      : 'cumulative session totals';

  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <Rule width={inner} />
      <box flexDirection="row" height={3}>
        <box flexDirection="column" width={cellW}>
          <box flexDirection="row" height={1}>
            <text fg={DIMMER}>SESSION TOKENS</text>
            <box flexGrow={1} />
            <text fg={BRIGHT}>{fmtTokens(tokens)}</text>
          </box>
          <box height={1}>
            <text
              fg={DIM}
            >{`${sessions} session${sessions === 1 ? '' : 's'} · ${thread.agent}`}</text>
          </box>
          <box height={1}>
            <text fg={DIMMER}>{truncate(sessionScope, cellW)}</text>
          </box>
        </box>

        <VDivider />

        <box flexDirection="column" width={cellW}>
          <box flexDirection="row" height={1}>
            <text fg={DIMMER}>STEPS</text>
            <box flexGrow={1} />
            <text fg={BRIGHT}>{total > 0 ? `${done}/${total}` : '—'}</text>
          </box>
          <box height={1}>
            <StepDots thread={thread} maxDots={Math.max(3, Math.floor((cellW - 4) / 2))} />
          </box>
          <box height={1}>
            <text fg={DIMMER}>
              {truncate(
                total > 0 ? `${done} done · ${wip} wip · ${todo} todo` : 'no plan steps',
                cellW
              )}
            </text>
          </box>
        </box>

        <VDivider />

        <box flexDirection="column" width={lastW}>
          <box flexDirection="row" height={1}>
            <text fg={DIMMER}>ACTIVITY</text>
            <box flexGrow={1} />
            <text fg={DIM}>{`${Math.round(
              (DEFAULT_SPARKLINE.buckets * DEFAULT_SPARKLINE.bucketMs) / 60_000
            )}m`}</text>
          </box>
          <box height={1}>
            <Sparkline buckets={thread.sparkline} width={sparkW(lastW)} state={thread.state} />
          </box>
          <box height={1}>
            <text fg={DIMMER}>
              {truncate(`last active ${ago(thread.lastWriteMs, nowMs)}`, lastW)}
            </text>
          </box>
        </box>
      </box>
    </box>
  );
}
