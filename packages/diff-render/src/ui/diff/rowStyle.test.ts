import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  resolveTheme,
  TRANSPARENT_BACKGROUND,
  withTransparentSurfaces,
} from '../themes';
import {
  diffRailMarker,
  splitCellPalette,
  splitLeftRailColor,
  stackCellPalette,
  stackRailColor,
  subduedWordDiffBackground,
} from './rowStyle';

describe.each([DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID])(
  'subdued row presentation in %s',
  (themeId) => {
    const theme = resolveTheme(themeId, null);

    it('keeps both rail markers exactly one terminal cell wide', () => {
      expect(stringWidth(diffRailMarker('primary'))).toBe(1);
      expect(stringWidth(diffRailMarker('subdued'))).toBe(1);
      expect(diffRailMarker('primary')).toBe('▌');
      expect(diffRailMarker('subdued')).toBe('┊');
    });

    it('uses neutral surfaces while retaining semantic signs and line-number contrast', () => {
      expect(splitCellPalette('addition', theme, 'moved', 'subdued')).toEqual({
        gutterBg: theme.lineNumberBg,
        contentBg: theme.contextBg,
        signColor: theme.addedSignColor,
        numberColor: theme.lineNumberFg,
      });
      expect(stackCellPalette('deletion', theme, 'moved', 'subdued')).toEqual({
        gutterBg: theme.lineNumberBg,
        contentBg: theme.contextBg,
        signColor: theme.removedSignColor,
        numberColor: theme.lineNumberFg,
      });
      expect(splitLeftRailColor('deletion', theme, true, 'subdued')).toBe(theme.muted);
      expect(stackRailColor('addition', theme, true, 'subdued')).toBe(theme.muted);
    });

    it('softens intraline emphasis to the semantic row tint', () => {
      expect(subduedWordDiffBackground('addition', theme)).toBe(theme.addedBg);
      expect(subduedWordDiffBackground('deletion', theme)).toBe(theme.removedBg);
      expect(subduedWordDiffBackground('context', theme)).toBe(theme.contextContentBg);
    });
  }
);

describe('transparent subdued row presentation', () => {
  const theme = withTransparentSurfaces(resolveTheme(DEFAULT_DARK_THEME_ID, null));

  it('lets neutral cells pass through while retaining semantic intraline emphasis', () => {
    const palette = splitCellPalette('addition', theme, undefined, 'subdued');
    expect(palette.gutterBg).toBe(TRANSPARENT_BACKGROUND);
    expect(palette.contentBg).toBe(TRANSPARENT_BACKGROUND);
    expect(subduedWordDiffBackground('addition', theme)).toBe(theme.addedBg);
    expect(subduedWordDiffBackground('addition', theme)).not.toBe(TRANSPARENT_BACKGROUND);
  });
});
