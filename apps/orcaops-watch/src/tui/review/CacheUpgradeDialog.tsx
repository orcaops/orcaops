import { useKeyboard } from '@opentui/react';

import { useCockpitTheme } from '../ThemeProvider';
import { truncate } from '../layout';
import { ModalFrame } from './ModalFrame';

export interface CacheUpgradeDialogProps {
  cacheVersion: number;
  currentVersion: number;
  width: number;
  height: number;
  onConfirm: () => void;
  onDecline: () => void;
}

export function CacheUpgradeDialog({
  cacheVersion,
  currentVersion,
  width,
  height,
  onConfirm,
  onDecline,
}: CacheUpgradeDialogProps) {
  const { DIM, FG } = useCockpitTheme();

  useKeyboard((key) => {
    const sequence = key.sequence ?? key.name ?? '';
    if (key.name === 'return' || key.name === 'enter' || sequence.toLowerCase() === 'y') {
      key.preventDefault?.();
      onConfirm();
    } else if (
      key.name === 'escape' ||
      sequence === '\u001b' ||
      sequence.toLowerCase() === 'n' ||
      sequence.toLowerCase() === 'q'
    ) {
      key.preventDefault?.();
      onDecline();
    }
  });

  return (
    <ModalFrame
      id="cache-upgrade-dialog"
      backdropId="cache-upgrade-backdrop"
      title="Rebuild local cache?"
      width={width}
      height={height}
      desiredWidth={Math.min(74, Math.max(42, width - 8))}
      desiredHeight={Math.min(13, Math.max(10, height - 6))}
      onClose={onDecline}
      opaqueBackdrop
      actions={[
        {
          id: 'rebuild',
          keyLabel: 'Y',
          label: 'Rebuild now',
          shortLabel: 'Rebuild',
          priority: 0,
          onSelect: onConfirm,
        },
        {
          id: 'decline',
          keyLabel: 'N',
          label: 'Not now',
          shortLabel: 'Not now',
          priority: 0,
          onSelect: onDecline,
        },
      ]}
    >
      {(geometry) => (
        <>
          <text fg={FG}>
            {truncate(
              `This repository's local cache uses schema ${cacheVersion}; Orcaops now uses ${currentVersion}.`,
              geometry.innerWidth
            )}
          </text>
          <box height={1} flexShrink={0} />
          <text fg={DIM}>
            {truncate(
              'Captured history will not be changed. Rebuilding may take a moment.',
              geometry.innerWidth
            )}
          </text>
        </>
      )}
    </ModalFrame>
  );
}
