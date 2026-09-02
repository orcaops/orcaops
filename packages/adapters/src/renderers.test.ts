import { describe, expect, it } from 'vitest';

import { extractStamp, isVersionAhead, makeSkillRenderer } from './renderers.js';
import type { SkillTemplate } from './types.js';

describe('skill frontmatter: disable-model-invocation', () => {
  const renderer = makeSkillRenderer('.claude/skills', { includeTags: true });
  const base: SkillTemplate<string> = {
    id: 'demo',
    name: 'Orcaops: demo',
    description: 'A demo skill.',
    tags: ['orcaops', 'demo'],
    body: 'Body text.',
  };
  const render = (skill: SkillTemplate<string>): string =>
    renderer.format(skill, { generatedBy: '0.0.5' });

  it('a template omitting the field renders the frontmatter it renders today', () => {
    // Frozen golden. The bytes of every installed SKILL.md hang off this shape,
    // and their recorded contentHash stamps make any drift a real churn event.
    expect(render(base)).toBe(
      `---
name: "Orcaops: demo"
description: "A demo skill."
metadata:
  generatedBy: "orcaops@0.0.5"
  contentHash: "fe60924fa5b9"
tags: ["orcaops", "demo"]
---

Body text.
`
    );
  });

  it('a template setting the field renders the key, and nothing else moves', () => {
    const rendered = render({ ...base, disableModelInvocation: true });
    expect(rendered).toContain('\ndisable-model-invocation: true\n');
    expect(rendered.split('\n').slice(0, 4)).toEqual([
      '---',
      'name: "Orcaops: demo"',
      'description: "A demo skill."',
      'disable-model-invocation: true',
    ]);
    // Same document minus the new line — proof the field is the ONLY delta
    // besides the stamp it necessarily re-fingerprints.
    const stripped = rendered.replace('\ndisable-model-invocation: true', '');
    const baseline = render(base);
    expect(stripped.replace(/contentHash: "[^"]+"/, '')).toBe(
      baseline.replace(/contentHash: "[^"]+"/, '')
    );
    expect(extractStamp(rendered).fingerprint).not.toBe(extractStamp(baseline).fingerprint);
  });

  it('an explicit false renders identically to omitting the field', () => {
    expect(render({ ...base, disableModelInvocation: false })).toBe(render(base));
  });
});

describe('isVersionAhead', () => {
  it('a strictly newer triple is ahead', () => {
    expect(isVersionAhead('1.0.0', '0.9.9')).toBe(true);
    expect(isVersionAhead('0.1.0', '0.0.5')).toBe(true);
    expect(isVersionAhead('0.0.6', '0.0.5')).toBe(true);
    expect(isVersionAhead('99.0.0', '0.0.5')).toBe(true);
  });

  it('ignores -suffixes when ordering (dev/test stamps compare by triple)', () => {
    expect(isVersionAhead('99.0.0-stale', '0.0.5')).toBe(true);
    expect(isVersionAhead('1.0.0', '0.9.9-test.4')).toBe(true);
  });

  it('equal triples are never ahead (same-version fingerprint refresh preserved)', () => {
    expect(isVersionAhead('0.0.5', '0.0.5')).toBe(false);
    expect(isVersionAhead('0.0.5-rc1', '0.0.5')).toBe(false);
    expect(isVersionAhead('0.0.5', '0.0.5-test.4')).toBe(false);
  });

  it('older stamps are not ahead', () => {
    expect(isVersionAhead('0.0.4', '0.0.5')).toBe(false);
    expect(isVersionAhead('0.0.5', '0.1.0')).toBe(false);
    expect(isVersionAhead('0.0.0-stale', '0.0.5')).toBe(false);
  });

  it('unparseable versions on either side are not ahead (falls back to refresh)', () => {
    expect(isVersionAhead(null, '0.0.5')).toBe(false);
    expect(isVersionAhead(undefined, '0.0.5')).toBe(false);
    expect(isVersionAhead('', '0.0.5')).toBe(false);
    expect(isVersionAhead('garbage', '0.0.5')).toBe(false);
    expect(isVersionAhead('1.0.0', 'dev')).toBe(false);
    expect(isVersionAhead('1.0', '0.0.5')).toBe(false);
  });

  it('components above Number.MAX_SAFE_INTEGER still order exactly', () => {
    expect(isVersionAhead('9007199254740993.0.0', '9007199254740992.0.0')).toBe(true);
    expect(isVersionAhead('9007199254740992.0.0', '9007199254740993.0.0')).toBe(false);
    expect(isVersionAhead('9007199254740992.0.0', '9007199254740992.0.0')).toBe(false);
  });

  it('MANGLED trailing text is not a valid ahead version (pattern is end-anchored)', () => {
    expect(isVersionAhead('99.0.0garbage', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0.1', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0 ', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0/../etc', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0_1', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0', '0.0.5garbage')).toBe(false);
  });

  it('well-formed prerelease and build suffixes still parse', () => {
    expect(isVersionAhead('99.0.0-rc.1', '0.0.5')).toBe(true);
    expect(isVersionAhead('99.0.0+build.7', '0.0.5')).toBe(true);
    expect(isVersionAhead('99.0.0-alpha-2+build.7', '0.0.5')).toBe(true);
    expect(isVersionAhead('99.0.0-0.3.7', '0.0.5')).toBe(true); // numeric identifiers
    expect(isVersionAhead('99.0.0-x-y-z.--', '0.0.5')).toBe(true); // hyphen identifiers
    expect(isVersionAhead('0.0.5-test.4', '0.0.5')).toBe(false); // equal triple
  });

  it('MALFORMED semver identifiers are not a valid ahead version', () => {
    expect(isVersionAhead('99.0.0-..', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0-alpha..1', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0+..', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0-01', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0-alpha.', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0-', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0+', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0+build..7', '0.0.5')).toBe(false);
    expect(isVersionAhead('099.0.0', '0.0.5')).toBe(false);
    expect(isVersionAhead('99.0.0', '0.0.5-..')).toBe(false);
  });
});
