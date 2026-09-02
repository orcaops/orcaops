import { describe, expect, it } from "vitest";

import { sanitizeTerminalLine, sanitizeTerminalText } from "./terminalText.js";

const containsControlChars = (text: string) => /[\x00-\x1f\x7f-\x9f]/.test(text.replace(/[\n\t]/g, ""));

describe("sanitizeTerminalText resource bounds", () => {
  it("strips complete control sequences as before", () => {
    expect(sanitizeTerminalLine("a\x1b]0;title\x07b")).toBe("ab");
    expect(sanitizeTerminalLine("a\x1b[31mred\x1b[0mb")).toBe("aredb");
    expect(sanitizeTerminalLine("a\x9b31mb")).toBe("ab");
  });

  it("sanitizes the adversarial unterminated-OSC input in bounded time", () => {
    // The audit measured this exact shape quadratic pre-fix: 128k chars took
    // ~7s. Bounded spans + the sequence-scan limit keep it linear-ish; the
    // generous wall-clock bound guards the complexity class, not the exact
    // constant, so CI noise cannot flake it.
    const adversarial = "\x1b]".repeat(64_000);
    const start = performance.now();
    const out = sanitizeTerminalLine(adversarial);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1_000);
    expect(containsControlChars(out)).toBe(false);
  });

  it("sanitizes a megabyte-scale single line in bounded time with no surviving control chars", () => {
    const line = `${"x".repeat(500_000)}\x1b]unterminated${"y".repeat(500_000)}\x1b[31m`;
    const start = performance.now();
    const out = sanitizeTerminalLine(line);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1_000);
    expect(containsControlChars(out)).toBe(false);
    // Printable content beyond the sequence-scan limit is preserved.
    expect(out).toContain("y".repeat(1_000));
  });

  it("still strips control characters past the sequence-scan limit", () => {
    const line = "a".repeat(70_000) + "\x1b[31m\x07\x00tail";
    const out = sanitizeTerminalText(line, { preserveNewlines: false });
    expect(containsControlChars(out)).toBe(false);
    expect(out.endsWith("tail")).toBe(true);
  });

  it("preserves multibyte text across the sequence-scan boundary", () => {
    // The boundary slice may split a surrogate pair; concatenation of the
    // sanitized halves must reunite it. The leading BEL forces the sanitize
    // path (without a control character the function returns early).
    const emoji = "😀";
    const prefixLength = 65_536 - 2;
    const line = "\x07" + "a".repeat(prefixLength) + emoji + "tail";
    const out = sanitizeTerminalLine(line);
    expect(out).toBe("a".repeat(prefixLength) + emoji + "tail");
  });

  it("strips whole CSI sequences past the sequence-scan boundary (no style residue)", () => {
    const line = "a".repeat(70_000) + "\x1b[31mred-tail";
    const out = sanitizeTerminalLine(line);
    expect(out.endsWith("red-tail")).toBe(true);
    expect(out).not.toContain("[31m");
  });

  it("strips a CSI sequence that straddles the sequence-scan boundary", () => {
    // The ESC lands just before the 64 KiB boundary and the sequence body
    // crosses it; the full-input CSI pass removes it whole (no "[31m" residue
    // and no stray ESC).
    const line = "\x07" + "a".repeat(65_534) + "\x1b[31m" + "tail";
    const out = sanitizeTerminalLine(line);
    expect(out).toBe("a".repeat(65_534) + "tail");
  });

  it("preserves an ANSI style that straddles the sequence-scan boundary", () => {
    const line = "a".repeat(65_534) + "\x1b[31m" + "tail\x1b[0m";
    const out = sanitizeTerminalText(line, {
      preserveNewlines: false,
      preserveAnsiStyle: true,
    });
    expect(out).toBe("a".repeat(65_534) + "\x1b[31m" + "tail\x1b[0m");
  });

  it("preserves ANSI styles on both sides of the sequence-scan boundary", () => {
    const line = "\x1b[31mhead" + "a".repeat(70_000) + "\x1b[32mtail\x1b[0m";
    const out = sanitizeTerminalText(line, {
      preserveNewlines: false,
      preserveAnsiStyle: true,
    });
    expect(out.startsWith("\x1b[31mhead")).toBe(true);
    expect(out).toContain("\x1b[32mtail");
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  it("restores many preserved styles in one pass", () => {
    const styled = Array.from({ length: 10_000 }, (_, index) => `\x1b[3${index % 8}m${index}`).join(
      "",
    );
    const started = performance.now();
    const sanitized = sanitizeTerminalText(styled, {
      preserveNewlines: false,
      preserveAnsiStyle: true,
    });
    const elapsed = performance.now() - started;
    expect(sanitized).toBe(styled);
    expect(elapsed).toBeLessThan(500);
  });
});
