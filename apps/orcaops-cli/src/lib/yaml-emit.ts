import { Document, Scalar, YAMLSeq } from 'yaml';

/**
 * Shared YAML emission for the next-step hint heredocs. Real values go through
 * the `yaml` serializer so anything that would coerce on parse (`0123` → a
 * number, `true` → a boolean) or break the parse (a colon-space read as a
 * nested mapping) is quoted automatically — the renderer never hand-builds
 * `k: v` lines or hand-quotes. Prose placeholders are emitted as `|-`
 * block scalars via `blockScalar(...)` so the agent can drop multi-line text in.
 */

/**
 * A YAML `|-` block-literal scalar node — for prose and the `<placeholder>`
 * bodies the hints leave for the agent to fill in. (A value with no trailing
 * newline serializes with the strip chomping indicator, i.e. `|-`.)
 */
export function blockScalar(text: string): Scalar {
  const node = new Scalar(text);
  node.type = Scalar.BLOCK_LITERAL;
  return node;
}

/**
 * A YAML flow sequence (`[a, b, c]`) of string items. Each item is quoted by
 * the serializer only when it needs it; UUID step_ids round-trip safely and
 * stay plain, but a numeric-looking or colon-bearing item would be quoted.
 */
export function flowSeq(items: readonly string[]): YAMLSeq {
  const seq = new YAMLSeq();
  seq.flow = true;
  for (const item of items) seq.add(item);
  return seq;
}

/**
 * Serialize a capture-command body to YAML and wrap it in an
 * `orcaops capture <sub> --input -` heredoc. `body` is a plain object whose
 * values may be primitives, `blockScalar(...)`, `flowSeq(...)`, or nested
 * objects/arrays; key order is preserved.
 */
export function captureHeredoc(sub: string, body: Record<string, unknown>): string {
  const yamlBody = new Document(body).toString({ lineWidth: 0 }).trimEnd();
  return [`orcaops capture ${sub} --input - <<'EOF'`, yamlBody, 'EOF'].join('\n');
}
