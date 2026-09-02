// Vitest-only alias target for the exact-match `@opentui/core` and
// `@opentui/react` aliases (vitest.config.ts). The real packages import
// `bun:`-protocol modules at load, which the node ESM loader running vitest
// cannot resolve; the layout tests import through @orcaops/diff-render's
// barrel, whose vendored theme/composer chain names only these exports — and
// touches them lazily, so no-op shapes suffice. Jsx runtimes are NOT aliased
// (they re-export react's). No OpenTUI rendering happens under vitest.

export class SyntaxStyle {
  static fromStyles(_styles: unknown): SyntaxStyle {
    return new SyntaxStyle();
  }
}

export const RGBA = {
  fromHex(hex: string): { hex: string } {
    return { hex };
  },
};

export function flushSync<T>(fn: () => T): T {
  return fn();
}
