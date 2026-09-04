import type { WatchCheckpoint, WatchThread } from '@orcaops/watch-data/ui';

import { ago, fmtTokens } from '../../core/format';
import { useCockpitTheme } from '../ThemeProvider';
import { type DetailAction, type DetailLine, type DetailTone, wrapDetailText } from '../detail';
import { EVENT_FAMILY_THEME } from '../eventPresentation';
import { EmptyState, Rule, useHit } from '../kit';
import { displayLen, truncate } from '../layout';
import { readableProseWidth } from '../responsiveLayout';
import type { ScrollRef } from '../scroll';
import { type CockpitTheme, GLYPH, STATE_LABEL, UI_GLYPH } from '../theme';
import { VitalStrip } from './VitalStrip';

/** Duration formatter for the span meta ("4h 41m"), distinct from relative `ago`. */
function fmtSpan(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Wrap a title into at most two rows without duplicating long tokens. */
function wrapTitle(text: string, width: number): [string, string] {
  const rows = wrapDetailText(text, width);
  if (rows.length === 1) return [rows[0] ?? '', ''];
  if (rows.length === 2) return [rows[0] ?? '', rows[1] ?? ''];
  return [rows[0] ?? '', truncate(rows.slice(1).join(' '), width)];
}

/** The contextual callout below artifact metrics. */
function reasonLine(
  theme: CockpitTheme,
  thread: WatchThread,
  nowMs: number
): { text: string; color: string } | null {
  const steps = thread.steps ? `${thread.steps.completed}/${thread.steps.total} steps` : null;
  if (thread.openComments > 0) {
    return {
      text: `${thread.openComments} open review comment${thread.openComments === 1 ? '' : 's'} · action needed`,
      color: theme.AMBER,
    };
  }
  switch (thread.state) {
    case 'ready':
      return {
        text: `${steps ? `${steps} done · ` : ''}ready for your review`,
        color: theme.AMBER,
      };
    case 'stalled':
      return {
        text: `stalled ${ago(thread.lastWriteMs, nowMs)} · needs attention`,
        color: theme.AMBER,
      };
    case 'wrapping':
      return { text: `wrapping up${steps ? ` · ${steps}` : ''}`, color: theme.CYAN };
    default:
      return thread.currentLine ? { text: thread.currentLine, color: theme.DIMMER } : null;
  }
}

export function toneColor(theme: CockpitTheme, tone: DetailTone): string {
  switch (tone) {
    case 'section':
      return theme.DIMMER;
    case 'step-done':
      return theme.DIM;
    case 'step-current':
      return theme.BRIGHT;
    case 'step-todo':
      return theme.DIMMER;
    case 'cp':
      return theme.DIM;
    case 'cp-open':
      return theme.AMBER;
    case 'decision':
      return theme.ACCENT;
    case 'reason':
      return theme.DIMMER;
    case 'alt':
      return theme.FAINT;
    case 'guardrail':
      return theme.DIM;
    case 'question':
      return theme.AMBER;
    case 'detail':
      return theme.FG;
    case 'ev-checkpoint':
      return theme[EVENT_FAMILY_THEME.checkpoint];
    case 'ev-plan':
      return theme[EVENT_FAMILY_THEME.plan];
    case 'ev-summary':
      return theme[EVENT_FAMILY_THEME.summary];
    case 'ev-other':
      return theme.DIMMER;
    default:
      return theme.FAINT;
  }
}

function ActionButton({
  enabled,
  onPress,
  compact,
}: {
  enabled: boolean;
  onPress: () => void;
  compact: boolean;
}) {
  const { BRIGHT, DIMMER, SEL_BG, ACCENT } = useCockpitTheme();
  const hit = useHit({ hitId: 'watch-detail-review', enabled, onSelect: onPress });
  return (
    <box
      flexDirection="row"
      backgroundColor={enabled || hit.hovered ? SEL_BG : undefined}
      paddingLeft={1}
      paddingRight={1}
      onMouseOver={enabled ? hit.onMouseOver : undefined}
      onMouseOut={enabled ? hit.onMouseOut : undefined}
      onMouseDown={enabled ? hit.onMouseDown : undefined}
      onMouseUp={enabled ? hit.onMouseUp : undefined}
    >
      <text fg={enabled ? ACCENT : DIMMER}>{enabled ? '▶ ' : '× '}</text>
      <text fg={enabled ? BRIGHT : DIMMER}>{compact ? 'Review  v' : 'Review branch  v'}</text>
    </box>
  );
}

function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  const { ACCENT, BRIGHT, SEL_BG } = useCockpitTheme();
  const hit = useHit({ hitId: 'watch-detail-back', onSelect: onBack });
  return (
    <box
      flexDirection="row"
      backgroundColor={SEL_BG}
      paddingLeft={1}
      paddingRight={1}
      onMouseOver={hit.onMouseOver}
      onMouseOut={hit.onMouseOut}
      onMouseDown={hit.onMouseDown}
      onMouseUp={hit.onMouseUp}
    >
      <text fg={ACCENT}>{'‹ '}</text>
      <text fg={BRIGHT}>{label}</text>
    </box>
  );
}

/** The pushed view for one checkpoint; Back stays in the sticky header above it. */
function CheckpointCard({ cp, width }: { cp: WatchCheckpoint; width: number }) {
  const { AMBER, BRIGHT, DIM, DIMMER, FG, LIVE, RED, ACCENT } = useCockpitTheme();
  const added = cp.linesAdded ?? 0;
  const removed = cp.linesRemoved ?? 0;
  const total = added + removed;
  const fileLabel =
    cp.filesChanged === null ? '' : ` · ${cp.filesChanged} file${cp.filesChanged === 1 ? '' : 's'}`;
  const fixedBarWidth =
    displayLen(`+${added} `) + displayLen(` -${removed}`) + displayLen(fileLabel);
  const showDiffBar = width >= 56 && width - fixedBarWidth >= 8;
  const barWidth = showDiffBar ? Math.min(24, width - fixedBarWidth) : 0;
  const proseWidth = readableProseWidth(width);
  const addWidth = total > 0 ? Math.round((barWidth * added) / total) : 0;
  return (
    <box flexDirection="column" width={width}>
      <text fg={cp.status === 'open' ? AMBER : LIVE}>
        {truncate(
          `${cp.status === 'open' ? '◉' : '●'} CHECKPOINT ${cp.n} · ${cp.status.toUpperCase()}`,
          width
        )}
      </text>
      {cp.linesAdded !== null && cp.linesRemoved !== null ? (
        total > 0 ? (
          showDiffBar ? (
            <box flexDirection="row">
              <text fg={LIVE}>{`+${added} `}</text>
              <text fg={LIVE}>{'▓'.repeat(addWidth)}</text>
              <text fg={RED}>{'▓'.repeat(barWidth - addWidth)}</text>
              <text fg={RED}>{` -${removed}`}</text>
              {fileLabel.length > 0 ? <text fg={DIMMER}>{fileLabel}</text> : null}
            </box>
          ) : (
            <box flexDirection="column">
              {wrapDetailText(`+${added} / -${removed}${fileLabel}`, width).map((line, index) => (
                <text key={`diff-summary:${index}`} fg={DIM}>
                  {line}
                </text>
              ))}
            </box>
          )
        ) : (
          <box flexDirection="column">
            {wrapDetailText(`No line delta recorded${fileLabel}`, width).map((line, index) => (
              <text key={`empty-diff:${index}`} fg={DIMMER}>
                {line}
              </text>
            ))}
          </box>
        )
      ) : cp.filesChanged !== null ? (
        <box flexDirection="column">
          {wrapDetailText(
            `${cp.filesChanged} file${cp.filesChanged === 1 ? '' : 's'} changed`,
            width
          ).map((line, index) => (
            <text key={`files-changed:${index}`} fg={DIMMER}>
              {line}
            </text>
          ))}
        </box>
      ) : (
        <box flexDirection="column">
          {wrapDetailText('Diff metrics available when this checkpoint closes', width).map(
            (line, index) => (
              <text key={`pending-diff:${index}`} fg={DIMMER}>
                {line}
              </text>
            )
          )}
        </box>
      )}

      {cp.summary ? (
        <box id="watch-checkpoint-prose" width={proseWidth} flexDirection="column" paddingTop={1}>
          <text fg={DIMMER}>{truncate('SUMMARY', proseWidth)}</text>
          {wrapDetailText(cp.summary, proseWidth, '  ', '  ').map((line, index) => (
            <text key={`summary:${index}`} fg={FG}>
              {line}
            </text>
          ))}
        </box>
      ) : (
        <box flexDirection="column" paddingTop={1}>
          {wrapDetailText('Summary will appear when the checkpoint closes.', proseWidth).map(
            (line, index) => (
              <text key={`pending-summary:${index}`} fg={DIMMER}>
                {line}
              </text>
            )
          )}
        </box>
      )}

      {cp.steps.length > 0 ? (
        <box flexDirection="column" paddingTop={1}>
          <text fg={DIMMER}>
            {truncate(`SCOPE · ${cp.steps.length} step${cp.steps.length === 1 ? '' : 's'}`, width)}
          </text>
          {cp.steps.map((step) => (
            <text key={`step:${step.idx}`} fg={cp.status === 'open' ? AMBER : DIM}>
              {truncate(
                `  ${cp.status === 'open' ? '▸' : '✓'} ${step.idx + 1}. ${step.label}`,
                width
              )}
            </text>
          ))}
        </box>
      ) : null}

      {cp.decisions.length > 0 ? (
        <box flexDirection="column" paddingTop={1}>
          <text fg={DIMMER}>{truncate(`DECISIONS · ${cp.decisions.length}`, width)}</text>
          {cp.decisions.map((decision, index) => (
            <box key={`decision:${index}:${decision.decision}`} flexDirection="column">
              {wrapDetailText(decision.decision, proseWidth, '  → ', '    ').map((line, row) => (
                <text key={`decision:${row}`} fg={ACCENT}>
                  {line}
                </text>
              ))}
              {wrapDetailText(decision.reason, proseWidth, '     — ', '       ').map(
                (line, row) => (
                  <text key={`reason:${row}`} fg={DIMMER}>
                    {line}
                  </text>
                )
              )}
              {(decision.alternatives ?? []).flatMap((alternative, alternativeIndex) =>
                wrapDetailText(
                  `${alternative.option} — ${alternative.reason}`,
                  proseWidth,
                  '     × ',
                  '       '
                ).map((line, row) => (
                  <text key={`alternative:${alternativeIndex}:${row}`} fg={DIM}>
                    {line}
                  </text>
                ))
              )}
            </box>
          ))}
        </box>
      ) : null}

      {cp.uncertainties.length > 0 ? (
        <box flexDirection="column" paddingTop={1}>
          <text fg={DIMMER}>
            {truncate(`RECORDED UNCERTAINTIES · ${cp.uncertainties.length}`, width)}
          </text>
          {cp.uncertainties.flatMap((uncertainty, index) =>
            wrapDetailText(uncertainty, proseWidth, '  ? ', '    ').map((line, row) => (
              <text key={`uncertainty:${index}:${row}`} fg={AMBER}>
                {line}
              </text>
            ))
          )}
        </box>
      ) : null}
      <text> </text>
      <text fg={BRIGHT}>{truncate('End of checkpoint details', width)}</text>
    </box>
  );
}

function actionHint(action: DetailAction | undefined, selected: boolean): string {
  if (action === undefined) return '';
  if (!selected) return action === 'open' ? ' ›' : action === 'collapse' ? ' −' : ' +';
  if (action === 'open') return ' open ›';
  return action === 'collapse' ? ' collapse −' : ' expand +';
}

function DetailLineHit({
  line,
  selected,
  focused,
  width,
  onActivate,
}: {
  line: DetailLine;
  selected: boolean;
  focused: boolean;
  width: number;
  onActivate: (ref: string) => void;
}) {
  const theme = useCockpitTheme();
  const { BRIGHT, DIMMER, FOCUS_MARKER, SEL_BG } = theme;
  const interactive = line.ref !== null;
  const hit = useHit({
    hitId: `watch-detail-row:${line.id}`,
    enabled: interactive,
    // A committed click follows the same select-and-activate path as Enter.
    // Pointer hover is intentionally visual only.
    onSelect: interactive ? () => onActivate(line.ref!) : undefined,
  });
  const hint = actionHint(line.action, selected);
  const marker = selected ? (focused ? UI_GLYPH.paneFocused : UI_GLYPH.paneBlurred) : ' ';
  const textWidth = Math.max(1, width - 1 - displayLen(hint));
  return (
    <box
      flexDirection="row"
      backgroundColor={selected || hit.hovered ? SEL_BG : undefined}
      onMouseOver={interactive ? hit.onMouseOver : undefined}
      onMouseOut={interactive ? hit.onMouseOut : undefined}
      onMouseDown={interactive ? hit.onMouseDown : undefined}
      onMouseUp={interactive ? hit.onMouseUp : undefined}
    >
      <text fg={selected ? (focused ? FOCUS_MARKER : DIMMER) : DIMMER}>{marker}</text>
      <text fg={toneColor(theme, line.tone)}>{truncate(line.text, textWidth)}</text>
      <box flexGrow={1} />
      {hint.length > 0 ? <text fg={selected ? BRIGHT : DIMMER}>{hint}</text> : null}
    </box>
  );
}

/** The detail pane: selected artifact identity, sticky navigation, content, and vitals. */
export function DetailPane({
  thread,
  project,
  width,
  nowMs,
  focused,
  scrollRef,
  detailCp,
  selectedRef,
  lines,
  taskParent,
  reviewable,
  onRowActivate,
  onBack,
  onReview,
}: {
  thread: WatchThread | null;
  project: string | null;
  width: number;
  nowMs: number;
  focused: boolean;
  scrollRef: ScrollRef;
  detailCp: number | null;
  selectedRef: string | null;
  lines: readonly DetailLine[];
  taskParent: { memberIndex: number; memberCount: number } | null;
  reviewable: boolean;
  onRowActivate: (ref: string) => void;
  onBack: () => void;
  onReview: () => void;
}) {
  const theme = useCockpitTheme();
  const { COLOR, BRIGHT, DIM, DIMMER, FG, SEL_BG, ACCENT } = theme;
  if (thread === null) {
    return (
      <EmptyState
        id="watch-detail-empty"
        variant="screen"
        title="No artifact selected"
        message="Choose captured work from the thread rail to inspect its evidence."
      />
    );
  }

  const color = COLOR[thread.state];
  const tokens = thread.sessions.reduce((total, session) => total + session.tokens, 0);
  const steps = thread.steps;
  const inner = Math.min(112, Math.max(12, width - 2));
  const open = Math.max(
    thread.openCheckpoints,
    thread.checkpoints.filter((checkpoint) => checkpoint.status === 'open').length
  );
  const sessionCount = new Set(
    thread.sessions.map((session) => `${session.agent}:${session.session_id}`)
  ).size;
  const span = thread.startedAtMs === null ? null : fmtSpan(nowMs - thread.startedAtMs);
  const [title0, title1] = wrapTitle(thread.title, inner);
  const reason = reasonLine(theme, thread, nowMs);
  const drillCp =
    detailCp === null
      ? null
      : (thread.checkpoints.find((checkpoint) => checkpoint.n === detailCp) ?? null);
  const canGoBack = drillCp !== null || taskParent !== null;
  const breadcrumbLabel =
    drillCp !== null
      ? taskParent !== null
        ? `TASK › THREAD ${taskParent.memberIndex + 1}/${taskParent.memberCount} › CHECKPOINT ${drillCp.n}`
        : `ARTIFACT › CHECKPOINT ${drillCp.n}`
      : taskParent !== null
        ? `TASK › THREAD ${taskParent.memberIndex + 1}/${taskParent.memberCount}`
        : 'ARTIFACT';
  const backLabel = drillCp !== null ? 'Artifact' : 'Task';
  const pillLabel = ` ${GLYPH[thread.state]} ${STATE_LABEL[thread.state]} `;
  const pillWidth = displayLen(pillLabel);
  const breadcrumbWidth = Math.max(6, inner - pillWidth - (canGoBack ? 11 : 2));
  const identity = `${thread.agent} · ${thread.source}${
    thread.isCurrentCheckout ? ' · current checkout' : ''
  } · ${thread.artifactStatus} · ${sessionCount} session${sessionCount === 1 ? '' : 's'} · ${thread.artifactId.slice(
    0,
    8
  )}`;
  const lastClosedMs = thread.lastClosed ? Date.parse(thread.lastClosed.closed_at) : Number.NaN;
  const lastClosedUncertainties = thread.lastClosed?.uncertaintyCount ?? 0;
  const lastClosed = Number.isFinite(lastClosedMs)
    ? ` · last checkpoint ${ago(lastClosedMs, nowMs)}${
        lastClosedUncertainties > 0 ? ` (${lastClosedUncertainties} uncertainties)` : ''
      }`
    : '';
  const metrics = `${ago(thread.lastWriteMs, nowMs)} · ${fmtTokens(tokens)} session tokens${
    steps ? ` · ${steps.completed}/${steps.total} steps` : ''
  } · ${thread.checkpoints.length} checkpoint${thread.checkpoints.length === 1 ? '' : 's'}${
    open > 0 ? ` (${open} open)` : ''
  }${lastClosed}${span ? ` · ${span} span` : ''}`;
  const headerRows = 8 + (reason ? 1 : 0);
  const hasActions = lines.some((line) => line.ref !== null);
  const keyboardHint =
    drillCp !== null
      ? 'j/k scroll · ← back'
      : hasActions
        ? 'j/k select · Enter open'
        : 'j/k scroll · g/G ends';

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        height={headerRows}
        flexShrink={0}
      >
        <box flexDirection="row" height={1}>
          {canGoBack ? <BackButton label={backLabel} onBack={onBack} /> : null}
          {canGoBack ? <text> </text> : null}
          <text fg={ACCENT}>{truncate(breadcrumbLabel, breadcrumbWidth)}</text>
          <box flexGrow={1} />
          <box width={pillWidth} flexShrink={0}>
            <text fg={color} bg={SEL_BG}>
              {pillLabel}
            </text>
          </box>
        </box>
        <box height={1} flexDirection="row">
          <text fg={BRIGHT}>
            {truncate(`${project ? `${project}/` : ''}${thread.branch}`, inner)}
          </text>
        </box>
        <box height={1}>
          <text fg={FG}>{title0.length > 0 ? title0 : ' '}</text>
        </box>
        <box height={1}>
          <text fg={FG}>{title1.length > 0 ? title1 : ' '}</text>
        </box>
        <box height={1}>
          <text fg={DIM}>{truncate(identity, inner)}</text>
        </box>
        <box height={1}>
          <text fg={DIM}>{truncate(metrics, inner)}</text>
        </box>
        {reason ? (
          <box
            flexDirection="row"
            height={1}
            backgroundColor={SEL_BG}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={reason.color}>{truncate(`◆ ${reason.text}`, Math.max(4, inner - 2))}</text>
          </box>
        ) : null}
        <box flexDirection="row" height={1}>
          <ActionButton enabled={reviewable} onPress={onReview} compact={inner < 56} />
          <box flexGrow={1} />
          <text fg={focused ? BRIGHT : DIMMER}>
            {truncate(keyboardHint, Math.max(0, inner - 18))}
          </text>
        </box>
        <box height={1}>
          <Rule width={inner} />
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
        {drillCp !== null ? (
          <CheckpointCard cp={drillCp} width={inner} />
        ) : (
          <box flexDirection="column" width={inner}>
            {lines.map((line) => {
              const selected = line.ref !== null && line.ref === selectedRef;
              return (
                <DetailLineHit
                  key={line.id}
                  line={line}
                  selected={selected}
                  focused={focused}
                  width={inner}
                  onActivate={onRowActivate}
                />
              );
            })}
          </box>
        )}
      </scrollbox>

      <VitalStrip thread={thread} width={Math.min(width, 114)} nowMs={nowMs} />
    </box>
  );
}
