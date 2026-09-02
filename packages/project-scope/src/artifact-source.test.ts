import { describe, expect, it } from 'vitest';

import { resolveArtifactSource } from './artifact-source.js';

describe('resolveArtifactSource', () => {
  it.each([
    {
      name: 'neither projection exists',
      input: {
        hotPresent: false,
        archivePresent: false,
        hotLastWriteMs: null,
        archiveLastWriteMs: null,
      },
      expected: null,
    },
    {
      name: 'only hot exists',
      input: {
        hotPresent: true,
        archivePresent: false,
        hotLastWriteMs: 10,
        archiveLastWriteMs: null,
      },
      expected: { source: 'hot', lastWriteMs: 10 },
    },
    {
      name: 'only archive exists',
      input: {
        hotPresent: false,
        archivePresent: true,
        hotLastWriteMs: null,
        archiveLastWriteMs: 10,
      },
      expected: { source: 'archive', lastWriteMs: 10 },
    },
    {
      name: 'archive is strictly newer',
      input: {
        hotPresent: true,
        archivePresent: true,
        hotLastWriteMs: 10,
        archiveLastWriteMs: 11,
      },
      expected: { source: 'archive', lastWriteMs: 11 },
    },
    {
      name: 'hot is newer',
      input: {
        hotPresent: true,
        archivePresent: true,
        hotLastWriteMs: 11,
        archiveLastWriteMs: 10,
      },
      expected: { source: 'hot', lastWriteMs: 11 },
    },
    {
      name: 'timestamps tie',
      input: {
        hotPresent: true,
        archivePresent: true,
        hotLastWriteMs: 10,
        archiveLastWriteMs: 10,
      },
      expected: { source: 'hot', lastWriteMs: 10 },
    },
    {
      name: 'hot timestamp is unavailable',
      input: {
        hotPresent: true,
        archivePresent: true,
        hotLastWriteMs: null,
        archiveLastWriteMs: 10,
      },
      expected: { source: 'archive', lastWriteMs: 10 },
    },
    {
      name: 'archive timestamp is unavailable',
      input: {
        hotPresent: true,
        archivePresent: true,
        hotLastWriteMs: 10,
        archiveLastWriteMs: null,
      },
      expected: { source: 'hot', lastWriteMs: 10 },
    },
  ])('$name', ({ input, expected }) => {
    expect(resolveArtifactSource(input)).toEqual(expected);
  });
});
