import { ProjectDatabaseError } from './errors.js';
import { canonicalJson } from '../../events/canonical-json.js';

export type DatabaseJson =
  | null
  | boolean
  | number
  | string
  | DatabaseJson[]
  | { [key: string]: DatabaseJson };

export function serializeDatabaseValue(value: unknown): string {
  const seen = new Set<object>();
  const validate = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) {
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Provide finite, acyclic JSON values before retrying this operation'
      );
    }
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Database boundaries require materialized JSON, not handles, iterators or asynchronous results'
      );
    }
    seen.add(item);
    for (const child of Object.values(item)) validate(child);
    seen.delete(item);
  };
  validate(value);
  return canonicalJson(value);
}

export function copyDatabaseValue<T>(value: T): T {
  return JSON.parse(serializeDatabaseValue(value)) as T;
}
