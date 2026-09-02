import { useCockpitTheme } from '../ThemeProvider';
import { truncate } from '../layout';
import { SPACE } from '../theme';
import { useHit } from './hit';

export interface StateAction {
  id: string;
  label: string;
  onSelect: () => void;
}

interface StateCopy {
  id: string;
  title?: string;
  message: string;
  detail?: string;
  action?: StateAction;
}

type StateProps =
  | (StateCopy & {
      variant?: 'screen' | 'banner';
      width?: number;
    })
  | (StateCopy & {
      variant: 'inline';
      /** Inline states have an explicit row price so measured callers cannot drift. */
      rows: number;
      width: number;
      suffix?: string;
    });

type StateKind = 'empty' | 'error' | 'warning' | 'notice';

function stateColors(kind: StateKind) {
  const theme = useCockpitTheme();
  switch (kind) {
    case 'error':
      return { lead: theme.RED, body: theme.FG, background: theme.STALLED_BG };
    case 'warning':
      return { lead: theme.AMBER, body: theme.FG, background: theme.STALLED_BG };
    case 'notice':
      return { lead: theme.AMBER, body: theme.DIM, background: theme.PANEL_BG };
    case 'empty':
      return { lead: theme.ACCENT, body: theme.DIM, background: undefined };
  }
}

function stateGlyph(kind: StateKind): string {
  switch (kind) {
    case 'error':
      return '×';
    case 'warning':
      return '!';
    case 'notice':
      return '•';
    case 'empty':
      return '○';
  }
}

function inlineCopy(props: Extract<StateProps, { variant: 'inline' }>, kind: StateKind): string {
  const lead = props.title === undefined ? props.message : `${props.title} · ${props.message}`;
  const detail = props.detail === undefined ? lead : `${lead} · ${props.detail}`;
  const suffix = props.suffix === undefined ? detail : `${detail} · ${props.suffix}`;
  return `${stateGlyph(kind)} ${suffix}`;
}

function StateSurface({ kind, props }: { kind: StateKind; props: StateProps }) {
  const { DIMMER, FOCUS_BG, FOCUS_MARKER } = useCockpitTheme();
  const colors = stateColors(kind);
  const actionHit = useHit({
    hitId: props.action?.id ?? `${props.id}:no-action`,
    enabled: props.action !== undefined,
    onSelect: props.action?.onSelect,
  });

  if (props.variant === 'inline') {
    const rows = Math.max(1, props.rows);
    const width = Math.max(0, props.width);
    const copy = truncate(inlineCopy(props, kind), width);
    return (
      <box
        id={props.id}
        width={width}
        height={rows}
        flexShrink={0}
        flexDirection="column"
        backgroundColor={colors.background}
        onMouseOver={props.action === undefined ? undefined : actionHit.onMouseOver}
        onMouseOut={props.action === undefined ? undefined : actionHit.onMouseOut}
        onMouseDown={props.action === undefined ? undefined : actionHit.onMouseDown}
        onMouseUp={props.action === undefined ? undefined : actionHit.onMouseUp}
      >
        <text width={width} height={1} flexShrink={0} fg={colors.lead}>
          {copy}
        </text>
        {Array.from({ length: rows - 1 }, (_, index) => (
          <text key={index} width={width} height={1} flexShrink={0}>
            {' '.repeat(width)}
          </text>
        ))}
      </box>
    );
  }

  const variant = props.variant ?? 'screen';
  const title = props.title ?? props.message;
  const body = props.title === undefined ? undefined : props.message;
  return (
    <box
      id={props.id}
      width={props.width}
      flexGrow={variant === 'screen' ? 1 : undefined}
      flexShrink={variant === 'banner' ? 0 : undefined}
      flexDirection="column"
      justifyContent={variant === 'screen' ? 'center' : undefined}
      alignItems={variant === 'screen' ? 'center' : undefined}
      paddingLeft={SPACE.xs}
      paddingRight={SPACE.xs}
      paddingTop={variant === 'screen' ? SPACE.xs : 0}
      paddingBottom={variant === 'screen' ? SPACE.xs : 0}
      backgroundColor={variant === 'banner' ? colors.background : undefined}
    >
      <text fg={colors.lead}>
        {stateGlyph(kind)} {title}
      </text>
      {body === undefined ? null : <text fg={colors.body}>{body}</text>}
      {props.detail === undefined ? null : <text fg={DIMMER}>{props.detail}</text>}
      {props.action === undefined ? null : (
        <box
          id={props.action.id}
          height={1}
          flexShrink={0}
          paddingLeft={SPACE.xs}
          paddingRight={SPACE.xs}
          backgroundColor={FOCUS_BG}
          onMouseOver={actionHit.onMouseOver}
          onMouseOut={actionHit.onMouseOut}
          onMouseDown={actionHit.onMouseDown}
          onMouseUp={actionHit.onMouseUp}
        >
          <text fg={FOCUS_MARKER}>[{props.action.label}]</text>
        </box>
      )}
    </box>
  );
}

export function EmptyState(props: StateProps) {
  return <StateSurface kind="empty" props={props} />;
}

export function ErrorState(props: StateProps) {
  return <StateSurface kind="error" props={props} />;
}

export function WarningBanner(props: StateProps) {
  return <StateSurface kind="warning" props={props} />;
}

export function Notice(props: StateProps) {
  return <StateSurface kind="notice" props={props} />;
}
