export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    public readonly path: string
  ) {
    super(`canonicalJson: ${message} at ${path || '<root>'}`);
    this.name = 'CanonicalJsonError';
  }
}
export function canonicalJson(value: unknown): string {
  return serialize(value, '');
}
function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number ${value}`, path);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts = value.map((item, i) => serialize(item, `${path}[${i}]`));
        return `[${parts.join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const childPath = path === '' ? key : `${path}.${key}`;
        const childValue = obj[key];
        if (childValue === undefined) {
          continue;
        }
        parts.push(`${JSON.stringify(key)}:${serialize(childValue, childPath)}`);
      }
      return `{${parts.join(',')}}`;
    }
    case 'undefined':
      throw new CanonicalJsonError('undefined is not representable', path);
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof value}`, path);
  }
}
