import { createHash } from 'node:crypto';

import { HistoryConversionError } from './errors.js';

export interface LegacySourceMember {
  readonly relativePath: string;
  readonly bytes: Buffer;
}
export interface RetainedSourceMember {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytesBase64: string;
}
function sourceIntegrity(resource: string, message: string): never {
  throw new HistoryConversionError('SOURCE_INTEGRITY', message, resource);
}
export class SourceMembers {
  readonly names: readonly string[];
  readonly #files: ReadonlyMap<string, Buffer>;
  readonly #used = new Set<string>();

  constructor(input: readonly LegacySourceMember[]) {
    const copied = input.map(({ relativePath, bytes }) => ({
      relativePath,
      bytes: Buffer.from(bytes),
    }));
    const files = new Map<string, Buffer>();
    for (const { relativePath, bytes } of copied) {
      if (
        relativePath.includes('\\') ||
        relativePath.includes('\0') ||
        relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
        files.has(relativePath)
      )
        sourceIntegrity(relativePath, 'Source member paths must be unique relative paths');
      files.set(relativePath, bytes);
    }
    this.#files = files;
    this.names = Object.freeze([...files.keys()].sort());
  }

  bytes(name: string): Buffer {
    const bytes = this.#files.get(name);
    if (!bytes)
      throw new HistoryConversionError(
        'SOURCE_UNAVAILABLE',
        'Expected retained source member is absent',
        name
      );
    this.#used.add(name);
    return Buffer.from(bytes);
  }
  retain(): readonly RetainedSourceMember[] {
    const unknown = this.names.filter((name) => !this.#used.has(name));
    if (unknown.length)
      throw new HistoryConversionError(
        'UNSUPPORTED_RESOURCE_SCHEMA',
        'Source inventory contains an unclassified member',
        unknown[0]
      );
    return Object.freeze(
      this.names.map((relativePath) =>
        Object.freeze({
          relativePath,
          sha256: createHash('sha256').update(this.bytes(relativePath)).digest('hex'),
          bytesBase64: this.bytes(relativePath).toString('base64'),
        })
      )
    );
  }
}
