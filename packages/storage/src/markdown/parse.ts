import { parse as parseYaml } from 'yaml';

export interface ParsedMarkdown {
  /** Parsed YAML frontmatter, or an empty object if absent. */
  frontmatter: Record<string, unknown>;
  /** Everything after the frontmatter (or the entire input if no frontmatter). */
  body: string;
  /** Named `## section-name` blocks extracted from the body. */
  sections: Map<string, string>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a markdown document with optional YAML frontmatter and optional
 * `## section-name` named sections in the body.
 *
 * - Frontmatter must start at the very first character of the input.
 * - Section names are captured from the heading text (`## description` → `description`).
 * - Section content runs until the next `## ` heading or end-of-input.
 */
export function parseMarkdown(input: string): ParsedMarkdown {
  let frontmatter: Record<string, unknown> = {};
  let body = input;

  const m = input.match(FRONTMATTER_RE);
  if (m) {
    const yamlText = m[1] ?? '';
    const parsed = parseYaml(yamlText);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    } else if (parsed !== null && parsed !== undefined) {
      throw new Error('Frontmatter YAML must be a mapping (object).');
    }
    body = input.slice(m[0].length);
  }

  const sections = extractSections(body);
  return { frontmatter, body, sections };
}

function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let currentName: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentName !== null) {
      sections.set(currentName, currentLines.join('\n').trim());
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      currentName = headingMatch[1].trim();
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}
