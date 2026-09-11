import { describe, expect, it } from 'vitest';

import { encodeArtifactEvent } from './event-encoding.js';
import { decodeArtifactRecords } from './event-integrity.js';
import { uuidv7 } from '../ids/uuidv7.js';

describe('artifact event encoding', () => {
  it.each([5, 9000])('preserves explicit identity and exact payload for %i bytes', (length) => {
    const value = 'x'.repeat(length);
    const eventId = uuidv7();
    const payload = { reasoning: value };
    const encoded = encodeArtifactEvent({
      event_id: eventId,
      type: 'checkpoint_closed',
      ts: '2026-09-05T00:00:00.000Z',
      idempotency_key: 'existing/non-uuid/key',
      payload,
    });
    expect(encoded.record.event_id).toBe(eventId);
    expect(encoded.record.idempotency_key).toBe('existing/non-uuid/key');
    expect(JSON.parse(encoded.payloadBytes.toString('utf8'))).toEqual(payload);
    expect(decodeArtifactRecords(encoded.eventBytes)).toEqual([encoded.record]);
    expect(encoded.sidecar !== null).toBe(value.length > 8192);
  });

  it('refuses invalid explicit event IDs and empty wire keys without writing', () => {
    const event = {
      type: 'summary_captured' as const,
      ts: '2026-09-05T00:00:00.000Z',
      payload: {},
    };
    expect(() =>
      encodeArtifactEvent({ ...event, event_id: '../outside', idempotency_key: 'key' })
    ).toThrow();
    expect(() => encodeArtifactEvent({ ...event, idempotency_key: '' })).toThrow();
  });
});
