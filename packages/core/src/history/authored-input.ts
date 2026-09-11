import { assertNoSecretsInPayload, SecretInPayloadError } from '@orcaops/storage';
import { type DatabaseJson, ProjectDatabaseError } from '@orcaops/storage/history/database';

export function refuseDatabaseAuthoredSecrets(
  value: unknown,
  allow: readonly string[],
  operation: 'setup' | 'snapshot preparation' | 'plan capture' | 'execution checkout'
): void {
  try {
    assertNoSecretsInPayload(value, allow);
    const inspectSourceStrings = (current: unknown): void => {
      if (typeof current === 'string') {
        for (const match of current.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(match[0]);
          } catch {
            continue;
          }
          assertNoSecretsInPayload(decoded, allow);
        }
      } else if (current && typeof current === 'object') {
        for (const [key, nested] of Object.entries(current)) {
          inspectSourceStrings(key);
          inspectSourceStrings(nested);
        }
      }
    };
    inspectSourceStrings(value);
  } catch (cause) {
    if (cause instanceof SecretInPayloadError)
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        `Remove or redescribe refused content before ${operation}; identical refused payloads are not retried`,
        { cause }
      );
    throw cause;
  }
}

export function copyDatabaseAuthoredValue(
  value: unknown,
  operation: 'setup' | 'snapshot preparation' | 'plan capture' | 'execution checkout' = 'setup',
  ancestors = new Set<object>()
): DatabaseJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    !value ||
    typeof value !== 'object' ||
    ancestors.has(value) ||
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      `Provide finite plain JSON authored payloads before ${operation}`
    );
  ancestors.add(value);
  try {
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
      ([key]) => !(Array.isArray(value) && key === 'length')
    );
    if (
      Object.getOwnPropertySymbols(value).length ||
      entries.some(([, descriptor]) => !('value' in descriptor) || !descriptor.enumerable)
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        `Authored ${operation} payloads must contain plain enumerable JSON values`
      );
    if (Array.isArray(value)) {
      if (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Provide complete JSON arrays without extra properties'
        );
      return entries.map(([, descriptor]) =>
        copyDatabaseAuthoredValue(descriptor.value, operation, ancestors)
      );
    }
    return Object.fromEntries(
      entries.map(([key, descriptor]) => [
        key,
        copyDatabaseAuthoredValue(descriptor.value, operation, ancestors),
      ])
    );
  } finally {
    ancestors.delete(value);
  }
}
