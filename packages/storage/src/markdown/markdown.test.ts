import { describe, expect, it } from 'vitest';

import { parseMarkdown } from './parse.js';
import { serializeMarkdown } from './serialize.js';

describe('parseMarkdown', () => {
  it('returns empty frontmatter and full body when no frontmatter present', () => {
    const r = parseMarkdown('Just some prose.\n');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('Just some prose.\n');
    expect(r.sections.size).toBe(0);
  });

  it('parses YAML frontmatter into an object', () => {
    const r = parseMarkdown(`---
artifact_id: abcdef12
n: 1
files_changed:
  - src/a.ts
  - src/b.ts
---

Body text here.
`);
    expect(r.frontmatter).toEqual({
      artifact_id: 'abcdef12',
      n: 1,
      files_changed: ['src/a.ts', 'src/b.ts'],
    });
    expect(r.body.trim()).toBe('Body text here.');
  });

  it('extracts named ## sections from the body', () => {
    const r = parseMarkdown(`---
severity: warn
---

## description
Human-readable rule context.
Across multiple lines.

## prompt
LLM instructions.
`);
    expect(r.sections.get('description')).toBe(
      'Human-readable rule context.\nAcross multiple lines.'
    );
    expect(r.sections.get('prompt')).toBe('LLM instructions.');
  });

  it('throws when frontmatter is not a mapping', () => {
    expect(() => parseMarkdown('---\n- 1\n- 2\n---\n')).toThrow();
  });

  it('handles CRLF line endings', () => {
    const r = parseMarkdown('---\r\nartifact_id: x\r\n---\r\n\r\nBody\r\n');
    expect(r.frontmatter.artifact_id).toBe('x');
    expect(r.body.trim()).toBe('Body');
  });
});

describe('serializeMarkdown', () => {
  it('writes frontmatter + body', () => {
    const out = serializeMarkdown({
      frontmatter: { artifact_id: 'abcdef12', n: 1 },
      body: 'Some prose.',
    });
    expect(out).toBe('---\nartifact_id: abcdef12\nn: 1\n---\n\nSome prose.\n');
  });

  it('omits frontmatter block when frontmatter is empty', () => {
    expect(serializeMarkdown({ body: 'just prose' })).toBe('just prose\n');
    expect(serializeMarkdown({ frontmatter: {}, body: 'just prose' })).toBe('just prose\n');
  });

  it('writes frontmatter only when body is empty', () => {
    expect(serializeMarkdown({ frontmatter: { x: 1 } })).toBe('---\nx: 1\n---\n');
  });

  it('round-trips frontmatter + body through parse', () => {
    const original = serializeMarkdown({
      frontmatter: { artifact_id: 'abc', tags: ['x', 'y'] },
      body: 'Line one.\nLine two.',
    });
    const parsed = parseMarkdown(original);
    expect(parsed.frontmatter).toEqual({ artifact_id: 'abc', tags: ['x', 'y'] });
    expect(parsed.body.trim()).toBe('Line one.\nLine two.');
  });
});
