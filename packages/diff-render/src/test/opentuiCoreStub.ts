// Vitest-only alias target for `@opentui/core` — OUR code (not vendored).
//
// The real package imports `bun:`-protocol modules at load, which the node ESM
// loader running vitest cannot resolve. The vendored theme chain only touches
// two of its exports, and only lazily (`withLazySyntaxStyle` defers
// `createSyntaxStyle` behind a getter), so this stub keeps geometry tests able
// to import through `pierre.ts`/`themes.ts` without ever rendering.

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
