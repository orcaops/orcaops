import path from 'node:path';

import { sha256Hex } from '@orcaops/storage';

import { DEFAULT_PREFIX } from './refs.js';
import type {
  CommandRenderer,
  RenderOptions,
  SkillRenderer,
  SubagentOrchestration,
} from './types.js';

/**
 * Generic, data-driven skill + command renderers.
 *
 * The per-tool file layout is a parameter (registry `skillsDir` + overlay
 * `commandRoot`), so adding a new agent is a data row (registry entry +
 * overlay), not a new renderer.
 *
 * Naming is derived from the active `prefix` (default `orcaops`):
 *   - skill dir:    `${skillsDir}/${prefix}-${verb}/SKILL.md`
 *   - command file: `${commandRoot}/${prefix}/${verb}.md`
 *   - command name: `${prefix}:${verb}` (skills keep their prose `name`).
 */

/**
 * YAML-safe double-quoted string emit. Escapes backslashes, double quotes, and
 * newlines.
 */
export function quote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * The stamp embedded in generated frontmatter: the CLI version plus a content
 * fingerprint of the pristine render (the document with the contentHash line
 * itself excluded). The fingerprint is what lets `planFile` see a template body
 * change shipped at an UNCHANGED CLI version — version-only stamps left
 * installed trees silently stale on every body-only edit (the same-version
 * refresh gap). A file whose recorded stamp equals the candidate's is the same
 * generation, so any byte difference is a user edit and stays respected.
 */
export interface GeneratedStamp {
  /** Version captured from `generatedBy: "orcaops@<v>"`, or null when absent. */
  version: string | null;
  /** Fingerprint captured from `contentHash: "<fp>"`, or null when absent. */
  fingerprint: string | null;
}

const GENERATED_BY_RE = /generatedBy:\s*"orcaops@([^"\n]+)"/;
const CONTENT_HASH_RE = /\n {2}contentHash:\s*"([^"\n]+)"/;

/** Parse the generation stamp out of a rendered skill/command document. */
export function extractStamp(content: string): GeneratedStamp {
  const version = content.match(GENERATED_BY_RE);
  const fingerprint = content.match(CONTENT_HASH_RE);
  return { version: version ? version[1] : null, fingerprint: fingerprint ? fingerprint[1] : null };
}

/**
 * On-disk stamp NEWER than the running CLI: the ahead-guard held
 * (`preserved-ahead`) or `update --force` overrode it (`forced-downgrade`).
 */
export type StampDivergence = 'preserved-ahead' | 'forced-downgrade';

/**
 * Semver 2.0.0 exactly, anchored; groups 1-3 are the ordering triple. Anything
 * looser reads mangled text (`99.0.0garbage`, `99.0.0-..`) as valid and
 * preserves it as "ahead" forever instead of refreshing it; anything stricter
 * risks rejecting a real ahead version, which would downgrade the file — the
 * very harm the guard prevents. Accepting garbage merely over-preserves.
 */
const SEMVER_TRIPLE_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * True when `candidate` is strictly semver-NEWER than `reference` by numeric
 * triple. Suffixes are ignored for ordering, so equal triples are never ahead
 * (the same-version fingerprint refresh keeps working); unparseable input on
 * either side is never ahead (mangled stamps refresh instead of persisting).
 */
export function isVersionAhead(candidate: string | null | undefined, reference: string): boolean {
  if (candidate == null) return false;
  const a = candidate.match(SEMVER_TRIPLE_RE);
  const b = reference.match(SEMVER_TRIPLE_RE);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    // BigInt: number parsing above 2^53 collapses distinct components to
    // equal, which would let a hugely-versioned newer file be overwritten.
    const ai = BigInt(a[i]);
    const bi = BigInt(b[i]);
    if (ai !== bi) return ai > bi;
  }
  return false;
}

/**
 * Insert the contentHash line into a rendered document. `head` ends at the
 * generatedBy line; the fingerprint hashes head+tail — the document WITHOUT the
 * line being inserted — so generation stays deterministic and re-derivable.
 * Exported for non-markdown artifact renderers (the OpenCode session plugin's
 * JS block-comment stamp) so every generated file shares one stamp format.
 */
export function stampedDocument(head: string, tail: string): string {
  const fingerprint = sha256Hex(head + tail).slice(0, 12);
  return `${head}\n  contentHash: "${fingerprint}"${tail}`;
}

export interface SkillRendererOptions {
  /**
   * Whether the skill frontmatter includes a `tags:` line. Claude Code renders
   * tags; Codex deliberately omits them (its loader only reads name +
   * description). Kept per-agent so generated files stay byte-identical.
   */
  includeTags: boolean;
  subagentOrchestration?: SubagentOrchestration;
}

export function makeSkillRenderer(skillsDir: string, opts: SkillRendererOptions): SkillRenderer {
  return {
    filePath(skillId: string, prefix: string = DEFAULT_PREFIX): string {
      // posix.join, not join: this is a repo-relative MANIFEST path and that
      // contract is slash-only. Consumers either join it onto a root, where
      // node:path renormalizes, or compare it against a recorded path, where a
      // platform separator silently never matches.
      return path.posix.join(skillsDir, `${prefix}-${skillId}`, 'SKILL.md');
    },
    format(skill, ro: RenderOptions): string {
      const prefix = ro.prefix ?? DEFAULT_PREFIX;
      const body =
        typeof skill.body === 'function'
          ? skill.body(prefix, { subagentOrchestration: opts.subagentOrchestration })
          : skill.body;
      const tagsLine =
        opts.includeTags && skill.tags && skill.tags.length > 0
          ? `\ntags: [${skill.tags.map(quote).join(', ')}]`
          : '';
      // Top-level scalar, emitted before the `metadata:` mapping so the stamp
      // lines stay the last thing in `head` (stampedDocument splices contentHash
      // directly after generatedBy). Omitted when unset — an always-emitted
      // `false` would churn every installed skill's contentHash.
      const disableModelInvocationLine = skill.disableModelInvocation
        ? '\ndisable-model-invocation: true'
        : '';
      const head = `---
name: ${quote(skill.name)}
description: ${quote(skill.description)}${disableModelInvocationLine}
metadata:
  generatedBy: "orcaops@${ro.generatedBy}"`;
      const tail = `${tagsLine}
---

${body.trim()}
`;
      return stampedDocument(head, tail);
    },
  };
}

export interface CommandRendererOptions {
  /**
   * File placement. `nested` is the Claude Code shape
   * (`${commandRoot}/${prefix}/${verb}.md` → `/${prefix}:${verb}`); `flat`
   * places `${commandRoot}/${prefix}-${verb}.md` for agents whose loader skips
   * subdirectories (the Cursor CLI reads only top-level `.md` files).
   */
  layout: 'nested' | 'flat';
  /**
   * Frontmatter shape. `full` is the Claude Code frontmatter
   * (name/description/metadata/tags); its bytes are frozen — installed files
   * are compared byte-for-byte. `minimal` emits only `description:` (AiderDesk
   * requires it; its unknown-key tolerance is undocumented) with the
   * `generatedBy` stamp as an HTML comment after the frontmatter. `none` emits
   * a body-only file with the stamp comment (Cursor parses no command
   * frontmatter). Both comment forms carry the `generatedBy` + `contentHash`
   * stamp lines (multi-line comment), so every generated command file is
   * drift-trackable exactly like skills and full-frontmatter commands.
   */
  frontmatter: 'full' | 'minimal' | 'none';
}

export function makeCommandRenderer(
  commandRoot: string,
  opts: CommandRendererOptions
): CommandRenderer {
  return {
    filePath(commandId: string, prefix: string = DEFAULT_PREFIX): string {
      // posix.join — see the skill renderer above.
      return opts.layout === 'flat'
        ? path.posix.join(commandRoot, `${prefix}-${commandId}.md`)
        : path.posix.join(commandRoot, prefix, `${commandId}.md`);
    },
    format(command, ro: RenderOptions): string {
      const prefix = ro.prefix ?? DEFAULT_PREFIX;
      const body = typeof command.body === 'function' ? command.body(prefix) : command.body;
      if (opts.frontmatter === 'none') {
        // Cursor parses no command frontmatter, so the stamp rides an HTML
        // comment. The contentHash line lives INSIDE the comment (multi-line)
        // so every generated command file carries a fingerprint the same-version
        // drift check can read — matching skills and full-frontmatter commands.
        // Cursor ignores the comment wholesale.
        return stampedDocument(
          `<!-- generatedBy: "orcaops@${ro.generatedBy}"`,
          ` -->\n\n${body.trim()}\n`
        );
      }
      if (opts.frontmatter === 'minimal') {
        return stampedDocument(
          `---
description: ${quote(command.description)}
---

<!-- generatedBy: "orcaops@${ro.generatedBy}"`,
          ` -->

${body.trim()}
`
        );
      }
      const tagsLine =
        command.tags && command.tags.length > 0
          ? `\ntags: [${command.tags.map(quote).join(', ')}]`
          : '';
      const head = `---
name: ${quote(`${prefix}:${command.id}`)}
description: ${quote(command.description)}
metadata:
  generatedBy: "orcaops@${ro.generatedBy}"`;
      const tail = `${tagsLine}
---

${body.trim()}
`;
      return stampedDocument(head, tail);
    },
  };
}
