import { stringify as stringifyYaml } from 'yaml';

export interface SerializeOptions {
  frontmatter?: Record<string, unknown>;
  body?: string;
}

/**
 * Serialize a markdown document with optional YAML frontmatter.
 * Produces a trailing newline. Frontmatter is omitted when empty/absent.
 */
export function serializeMarkdown(opts: SerializeOptions): string {
  const { frontmatter, body = '' } = opts;
  const trimmedBody = body.replace(/\s+$/, '');

  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return trimmedBody.length > 0 ? `${trimmedBody}\n` : '';
  }

  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).replace(/\s+$/, '');
  if (trimmedBody.length === 0) {
    return `---\n${yaml}\n---\n`;
  }
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}
