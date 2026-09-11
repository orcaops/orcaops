import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as eventFormat from './legacy/storage/events/event-log.js';
import * as identity from './legacy/storage/ids/uuidv7.js';
import { LEGACY_SOURCE_REVISION } from './profile.js';

const manifest = JSON.parse(
  readFileSync(new URL('../legacy-sources.json', import.meta.url), 'utf8')
) as {
  source_revision: string;
  entries: {
    source_path: string;
    source_sha256: string;
    output_path: string;
    output_sha256: string;
  }[];
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('frozen source provenance', () => {
  it('binds every copied schema and replay dependency to the pinned original source', () => {
    expect(manifest.source_revision).toBe(LEGACY_SOURCE_REVISION);
    for (const entry of manifest.entries) {
      const original = execFileSync('git', [
        'show',
        `${LEGACY_SOURCE_REVISION}:${entry.source_path}`,
      ]);
      const output = readFileSync(new URL('../' + entry.output_path, import.meta.url));
      expect(hash(original), entry.source_path).toBe(entry.source_sha256);
      expect(hash(output), entry.output_path).toBe(entry.output_sha256);
    }
  });

  it('does not retain source writer or ID allocation APIs in the decoder graph', () => {
    expect(eventFormat).not.toHaveProperty('appendEvent');
    expect(eventFormat).not.toHaveProperty('readEventLog');
    expect(identity).not.toHaveProperty('uuidv7');
    for (const entry of manifest.entries) {
      const source = readFileSync(new URL('../' + entry.output_path, import.meta.url), 'utf8');
      expect(source, entry.output_path).not.toMatch(
        /['"](?:node:fs(?:\/promises)?|node:child_process|@orcaops\/(?:storage|core|evaluator-protocol))['"]/
      );
    }
  });
});
