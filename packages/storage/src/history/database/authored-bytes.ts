import { ProjectDatabaseError } from './errors.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';

export function refuseJsonBytes(bytes: Buffer, allow: readonly string[]): void {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assertNoSecretsInPayload(text, allow);
    // JSON.parse drops earlier duplicate keys. Scan every decoded lexical string
    // so exact retained bytes cannot hide refused content behind a later key.
    for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
      assertNoSecretsInPayload(JSON.parse(match[0]), allow);
    }
  } catch (cause) {
    if (cause instanceof SecretInPayloadError) {
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        'Secret refusal: remove or redescribe refused content before a new attempt',
        { cause }
      );
    }
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide valid UTF-8 JSON source bytes', {
      cause,
    });
  }
}
