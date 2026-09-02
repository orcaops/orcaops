import { useCockpitTheme } from '../ThemeProvider';
import { useHit } from '../kit';
import { truncate } from '../layout';
import {
  type ShellMenuGroup,
  type ShellMenuId,
  shellMenuSpecs,
  shellMenuWidth,
} from '../shellMenuModel';

export interface ShellAction {
  id: string;
  label: string;
  active?: boolean;
  enabled?: boolean;
  onSelect: () => void;
}

function shellActionMarker(action: ShellAction): string {
  if (action.active === true) return '✓ ';
  if (action.enabled === false) return '× ';
  return action.active === false ? '  ' : '';
}

function ShellMenuTitle({
  id,
  label,
  width,
  active,
  enabled,
  onSelect,
  onHover,
}: {
  id: ShellMenuId;
  label: string;
  width: number;
  active: boolean;
  enabled: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const { BRIGHT, DIMMER, FAINT, FOCUS_BG, PANEL_BG, SEL_BG } = useCockpitTheme();
  const hit = useHit({
    hitId: `shell-menu-${id}`,
    enabled,
    onSelect,
    onHoverStart: onHover,
  });
  return (
    <box
      id={`shell-menu-${id}`}
      width={width}
      height={1}
      backgroundColor={active ? FOCUS_BG : hit.hovered ? SEL_BG : PANEL_BG}
      onMouseOver={enabled ? hit.onMouseOver : undefined}
      onMouseOut={enabled ? hit.onMouseOut : undefined}
      onMouseDown={enabled ? hit.onMouseDown : undefined}
      onMouseUp={enabled ? hit.onMouseUp : undefined}
    >
      <text fg={enabled ? (active ? BRIGHT : DIMMER) : FAINT}>{` ${label} `}</text>
    </box>
  );
}

function ShellActionHit({ action, enabled }: { action: ShellAction; enabled: boolean }) {
  const { BRIGHT, DIMMER, FAINT, FOCUS_BG, PANEL_BG, SEL_BG } = useCockpitTheme();
  const hit = useHit({
    hitId: `shell-action-${action.id}`,
    enabled,
    onSelect: action.onSelect,
  });
  return (
    <box
      id={`shell-action-${action.id}`}
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={action.active ? FOCUS_BG : hit.hovered ? SEL_BG : PANEL_BG}
      onMouseOver={enabled ? hit.onMouseOver : undefined}
      onMouseOut={enabled ? hit.onMouseOut : undefined}
      onMouseDown={enabled ? hit.onMouseDown : undefined}
      onMouseUp={enabled ? hit.onMouseUp : undefined}
    >
      <text fg={enabled ? (action.active ? BRIGHT : DIMMER) : FAINT}>
        {`${shellActionMarker(action)}${action.label}`}
      </text>
    </box>
  );
}

function ShellDropdownItem({
  item,
  index,
  selected,
  menuWidth,
  onHover,
  onSelect,
}: {
  item: ShellMenuGroup['items'][number];
  index: number;
  selected: boolean;
  menuWidth: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  const { BRIGHT, DIM, DIMMER, FAINT, FOCUS_BG, PANEL_BG } = useCockpitTheme();
  const enabled = item.enabled !== false;
  const hit = useHit({
    hitId: `shell-menu-item-${item.id}`,
    enabled,
    onSelect: () => onSelect(index),
    onHoverStart: () => onHover(index),
  });
  const check = !enabled ? '× ' : item.checked === undefined ? '  ' : item.checked ? '✓ ' : '  ';
  const hint = item.hint ?? '';
  const labelWidth = Math.max(1, menuWidth - hint.length - 6);
  return (
    <box
      id={`shell-menu-item-${item.id}`}
      height={1}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={selected || hit.hovered ? FOCUS_BG : PANEL_BG}
      onMouseOver={hit.onMouseOver}
      onMouseOut={hit.onMouseOut}
      onMouseDown={hit.onMouseDown}
      onMouseUp={hit.onMouseUp}
    >
      <text fg={enabled ? (selected ? BRIGHT : DIM) : FAINT}>
        {truncate(`${check}${item.label}`, labelWidth).padEnd(labelWidth)}
      </text>
      {hint.length > 0 ? <text fg={enabled ? DIMMER : FAINT}>{` ${hint}`}</text> : null}
    </box>
  );
}

/** Persistent application chrome shared by Watch and Review. */
export function ShellMenuBar({
  width,
  title,
  groups,
  activeMenu,
  actions = [],
  interactionEnabled = true,
  onToggleMenu,
  onHoverMenu,
}: {
  width: number;
  title: string;
  groups: readonly ShellMenuGroup[];
  activeMenu: ShellMenuId | null;
  actions?: readonly ShellAction[];
  /** False while a higher-precedence dialog/composer owns input. */
  interactionEnabled?: boolean;
  onToggleMenu: (id: ShellMenuId) => void;
  onHoverMenu: (id: ShellMenuId) => void;
}) {
  const { FAINT, PANEL_BG } = useCockpitTheme();
  const specs = shellMenuSpecs(groups);
  const actionsWidth = actions.reduce(
    (total, action) => total + shellActionMarker(action).length + action.label.length + 3,
    0
  );
  const menusWidth = specs.reduce((total, spec) => total + spec.width, 0);
  const titleWidth = Math.max(0, width - menusWidth - actionsWidth - 5);
  return (
    <box
      id="shell-menu-bar"
      height={1}
      width={width}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={PANEL_BG}
      paddingLeft={1}
      paddingRight={1}
    >
      {specs.map((spec) => {
        const active = activeMenu === spec.id;
        return (
          <ShellMenuTitle
            key={spec.id}
            id={spec.id}
            label={spec.label}
            width={spec.width}
            active={active}
            enabled={interactionEnabled}
            onSelect={() => onToggleMenu(spec.id)}
            onHover={() => onHoverMenu(spec.id)}
          />
        );
      })}
      <box flexGrow={1} height={1} justifyContent="flex-end">
        {titleWidth > 0 ? <text fg={FAINT}>{truncate(title, titleWidth)} </text> : null}
      </box>
      {actions.map((action) => {
        const enabled = interactionEnabled && action.enabled !== false;
        return <ShellActionHit key={action.id} action={action} enabled={enabled} />;
      })}
    </box>
  );
}

/** The open menu plane. Pointer and keyboard activation call the same item action. */
export function ShellMenuDropdown({
  group,
  groups,
  selectedIndex,
  terminalWidth,
  onHoverItem,
  onSelectItem,
}: {
  group: ShellMenuGroup;
  groups: readonly ShellMenuGroup[];
  selectedIndex: number;
  terminalWidth: number;
  onHoverItem: (index: number) => void;
  onSelectItem: (index: number) => void;
}) {
  const { FRAME, PANEL_BG } = useCockpitTheme();
  const specs = shellMenuSpecs(groups);
  const desiredWidth = shellMenuWidth(group.items);
  const menuWidth = Math.min(desiredWidth, Math.max(18, terminalWidth - 2));
  const desiredLeft = specs.find((spec) => spec.id === group.id)?.left ?? 1;
  const left = Math.max(1, Math.min(desiredLeft, terminalWidth - menuWidth - 1));
  return (
    <box
      id={`shell-dropdown-${group.id}`}
      position="absolute"
      top={1}
      left={left}
      zIndex={100}
      border
      borderColor={FRAME}
      backgroundColor={PANEL_BG}
      flexDirection="column"
      width={menuWidth}
      height={group.items.length + 2}
    >
      {group.items.map((item, index) => {
        const selected = selectedIndex === index;
        return (
          <ShellDropdownItem
            key={item.id}
            item={item}
            index={index}
            selected={selected}
            menuWidth={menuWidth}
            onHover={onHoverItem}
            onSelect={onSelectItem}
          />
        );
      })}
    </box>
  );
}
