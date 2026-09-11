import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { SourceMembers } from './source-members.js';

it('copies source bytes and returns exact retained identities', () => {
  const bytes = Buffer.from('original bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const source = new SourceMembers([{ relativePath: 'sidecars/input.json', bytes }]);
  bytes.fill(0);
  const copy = source.bytes('sidecars/input.json');
  expect(copy.toString()).toBe('original bytes');
  copy.fill(0);
  expect(source.retain()).toEqual([
    {
      relativePath: 'sidecars/input.json',
      sha256: hash,
      bytesBase64: Buffer.from('original bytes').toString('base64'),
    },
  ]);
});
it('refuses missing or unclassified source members', () => {
  const source = new SourceMembers([{ relativePath: 'extra.json', bytes: Buffer.from('safe') }]);
  expect(() => source.bytes('missing.json')).toThrow(
    expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' })
  );
  expect(() => source.retain()).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_RESOURCE_SCHEMA' })
  );
  source.bytes('extra.json');
  expect(source.retain()).toHaveLength(1);
});
it.each(['../escape', '/absolute', 'a//b', 'a\\b'])(
  'rejects an unsafe relative path %s',
  (relativePath) => {
    expect(() => new SourceMembers([{ relativePath, bytes: Buffer.alloc(0) }])).toThrow(
      expect.objectContaining({ code: 'SOURCE_INTEGRITY' })
    );
  }
);
