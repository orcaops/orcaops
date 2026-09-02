import { describe, expect, it } from 'vitest';

import { BUNDLED_SHIKI_THEME_IDS } from './lib/shikiThemes';
import { DEFAULT_DARK_THEME_ID, resolveTheme, THEMES } from './themes';

describe('bundled themes', () => {
  it('resolves every current Shiki theme id without remapping it', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(BUNDLED_SHIKI_THEME_IDS);

    for (const themeId of BUNDLED_SHIKI_THEME_IDS) {
      expect(resolveTheme(themeId, null).id).toBe(themeId);
    }
  });

  it('falls back for an unknown theme id', () => {
    expect(resolveTheme('unknown-theme', null).id).toBe(DEFAULT_DARK_THEME_ID);
  });
});
