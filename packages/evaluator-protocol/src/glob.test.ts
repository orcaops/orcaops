import { describe, expect, it } from 'vitest';

import {
  globMayMatchDescendant,
  globRequiresDirectoryTraversal,
  isValidGlobSyntax,
  matchesAnyGlob,
  toPosixPath,
} from './glob.js';

describe('toPosixPath', () => {
  it('rewrites backslashes to forward slashes', () => {
    expect(toPosixPath('src\\foo\\bar.py')).toBe('src/foo/bar.py');
  });
  it('is a no-op on already-POSIX paths', () => {
    expect(toPosixPath('src/foo/bar.py')).toBe('src/foo/bar.py');
  });
  it('rewrites mixed-separator paths', () => {
    expect(toPosixPath('src\\foo/bar\\baz.py')).toBe('src/foo/bar/baz.py');
  });
});

describe('isValidGlobSyntax', () => {
  it('accepts a literal path-like pattern', () => {
    expect(isValidGlobSyntax('src/foo.py')).toBe(true);
  });
  it('accepts a star pattern', () => {
    expect(isValidGlobSyntax('src/**/*.py')).toBe(true);
  });
  it('accepts a brace-expansion pattern', () => {
    expect(isValidGlobSyntax('src/**/*.{ts,tsx,js,jsx}')).toBe(true);
  });
  it('accepts a negation pattern', () => {
    expect(isValidGlobSyntax('!src/**/*.test.ts')).toBe(true);
  });
  it('accepts a character-class pattern', () => {
    expect(isValidGlobSyntax('src/file-[abc].ts')).toBe(true);
  });
  it('rejects the empty string', () => {
    expect(isValidGlobSyntax('')).toBe(false);
  });
  it('rejects non-string inputs', () => {
    // Defensive against caller misuse — Zod calls this from a refine
    // that's already been .string()'d, but the runner may call it
    // directly with config values it parses elsewhere.
    expect(isValidGlobSyntax(undefined as unknown as string)).toBe(false);
    expect(isValidGlobSyntax(null as unknown as string)).toBe(false);
    expect(isValidGlobSyntax(42 as unknown as string)).toBe(false);
  });
});

describe('matchesAnyGlob', () => {
  it('matches a POSIX path against a star pattern', () => {
    expect(matchesAnyGlob('src/foo/bar.py', ['src/**/*.py'])).toBe(true);
  });
  it('returns false when no pattern matches', () => {
    expect(matchesAnyGlob('tests/foo.py', ['src/**/*.py'])).toBe(false);
  });
  it('returns true on the first matching pattern in a list', () => {
    expect(matchesAnyGlob('src/foo/bar.tsx', ['src/**/*.py', 'src/**/*.{ts,tsx}'])).toBe(true);
  });
  it('normalizes Windows-style paths before matching', () => {
    expect(matchesAnyGlob('src\\foo\\bar.py', ['src/**/*.py'])).toBe(true);
  });
  it('normalizes Windows-style patterns before matching', () => {
    expect(matchesAnyGlob('src/foo/bar.py', ['src\\**\\*.py'])).toBe(true);
  });
  it('does not reinterpret an escaped literal as a path component', () => {
    expect(matchesAnyGlob('src/vendor/dependency.mjs', ['src/v\\endor/**/*.mjs'])).toBe(false);
  });
  it('returns false on an empty pattern array (no gating semantics live elsewhere)', () => {
    expect(matchesAnyGlob('src/foo.py', [])).toBe(false);
  });
  it('honors dot:true — `*` patterns DO match dotfiles', () => {
    // Documented behavior: pack authors writing `./checks/**/*.sh`
    // expect dot-prefixed siblings to be included.
    expect(matchesAnyGlob('src/.eslintrc.js', ['src/*.js'])).toBe(true);
  });
  it('matches absolute-style POSIX patterns', () => {
    expect(matchesAnyGlob('/repo/src/foo.py', ['/repo/src/**/*.py'])).toBe(true);
  });

  // ── substring-vs-glob disambiguation ──────────────────────────────
  // picomatch treats `src/` as a path prefix, not a substring —
  // `srcish/file.ts` does not match `src/**`. Tests below pin this
  // behavior so a regression to substring semantics fails loud.
  describe('substring-vs-glob disambiguation', () => {
    it('src/foo.ts matches src/**', () => {
      expect(matchesAnyGlob('src/foo.ts', ['src/**'])).toBe(true);
    });
    it('packages/foo/src/index.ts does NOT match src/**', () => {
      expect(matchesAnyGlob('packages/foo/src/index.ts', ['src/**'])).toBe(false);
    });
    it('packages/foo/src/index.ts matches **/src/**', () => {
      expect(matchesAnyGlob('packages/foo/src/index.ts', ['**/src/**'])).toBe(true);
    });
    it('srcish/file.ts does NOT match src/**', () => {
      expect(matchesAnyGlob('srcish/file.ts', ['src/**'])).toBe(false);
    });
    it('src.ts (no slash) does NOT match src/**', () => {
      expect(matchesAnyGlob('src.ts', ['src/**'])).toBe(false);
    });
    it('Windows backslash separators normalize before matching src/**', () => {
      expect(matchesAnyGlob('src\\foo.ts', ['src/**'])).toBe(true);
      expect(matchesAnyGlob('srcish\\file.ts', ['src/**'])).toBe(false);
    });
  });
});

describe('globMayMatchDescendant', () => {
  it('recognizes static and globbed paths below a directory', () => {
    expect(globMayMatchDescendant('linked', ['linked/**/*.ts'])).toBe(true);
    expect(globMayMatchDescendant('linked', ['linked/exact.ts'])).toBe(true);
    expect(globMayMatchDescendant('linked/nested', ['linked/**/*.ts'])).toBe(true);
  });

  it('recognizes patterns with no static directory prefix', () => {
    expect(globMayMatchDescendant('linked', ['**/*.ts'])).toBe(true);
  });

  it('ignores unrelated static prefixes', () => {
    expect(globMayMatchDescendant('vendor', ['src/**/*.ts'])).toBe(false);
    expect(globMayMatchDescendant('src/vendor', ['src/*.ts'])).toBe(false);
  });
});

describe('globRequiresDirectoryTraversal', () => {
  it('recognizes a symlink on the literal path to declared inputs', () => {
    expect(globRequiresDirectoryTraversal('linked', ['linked/**/*.ts'])).toBe(true);
    expect(globRequiresDirectoryTraversal('linked', ['linked/exact.ts'])).toBe(true);
  });

  it('recognizes statically named brace and extglob alternatives', () => {
    expect(globRequiresDirectoryTraversal('vendor', ['{runtime,vendor}/**/*.mjs'])).toBe(true);
    expect(globRequiresDirectoryTraversal('vendor', ['@(runtime|vendor)/**/*.mjs'])).toBe(true);
    expect(globRequiresDirectoryTraversal('src/vendor', ['src/{runtime,vendor}/**/*.mjs'])).toBe(
      true
    );
    expect(
      globRequiresDirectoryTraversal('src/vendor', ['{src/runtime,src/vendor}/**/*.mjs'])
    ).toBe(true);
    expect(
      globRequiresDirectoryTraversal('src/vendor', ['@(src/runtime|src/vendor)/**/*.mjs'])
    ).toBe(true);
    expect(globRequiresDirectoryTraversal('src/vendor', ['@(src/vendor)/**/*.mjs'])).toBe(true);
  });

  it('recognizes equivalent selectors and named directories after wildcards', () => {
    expect(globRequiresDirectoryTraversal('plugins/vendor', ['plugins/[v]endor/**/*.mjs'])).toBe(
      true
    );
    expect(globRequiresDirectoryTraversal('plugins/vendor', ['plugins/v?ndor/**/*.mjs'])).toBe(
      true
    );
    expect(globRequiresDirectoryTraversal('plugins/vendor', ['plugins/{v..v}endor/**/*.mjs'])).toBe(
      true
    );
    expect(globRequiresDirectoryTraversal('plugins/channel', ['plugins/*/vendor/**/*.mjs'])).toBe(
      true
    );
    expect(
      globRequiresDirectoryTraversal('plugins/channel/vendor', ['plugins/*/vendor/**/*.mjs'])
    ).toBe(true);
    expect(globRequiresDirectoryTraversal('plugins/channel', ['plugins/*/dependency.mjs'])).toBe(
      true
    );
    expect(globRequiresDirectoryTraversal('runtime', ['{run*,vendor}/**/*.mjs'])).toBe(true);
  });

  it('does not treat descendants reached only through wildcards as static inputs', () => {
    expect(globRequiresDirectoryTraversal('node_modules', ['**/*.mjs'])).toBe(false);
    expect(globRequiresDirectoryTraversal('src/vendor', ['src/**/*.ts'])).toBe(false);
    expect(globRequiresDirectoryTraversal('unrelated', ['{run*,vendor}/**/*.mjs'])).toBe(false);
    expect(globRequiresDirectoryTraversal('vendor', ['!(node_modules)/**/*.mjs'])).toBe(false);
    expect(globRequiresDirectoryTraversal('node_modules', ['!(node_modules)/**/*.mjs'])).toBe(
      false
    );
  });

  it('fails closed for quantified extglobs whose traversal cannot be finitely expanded', () => {
    expect(
      globRequiresDirectoryTraversal('node_modules', ['+(src/runtime|src/vendor)/**/*.mjs'])
    ).toBe(true);
    expect(globRequiresDirectoryTraversal('node_modules', ['*(src/vendor)/**/*.mjs'])).toBe(true);
    expect(globRequiresDirectoryTraversal('node_modules', ['+(@(src|lib)/vendor)/**/*.mjs'])).toBe(
      true
    );
  });
});
