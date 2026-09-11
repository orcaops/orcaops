import path from 'node:path';
export class PathContainmentError extends Error {
  constructor(
    message: string,
    public readonly label: string
  ) {
    super(message);
    this.name = 'PathContainmentError';
  }
}
export function assertSafeRelativePath(value: string, label: string): string {
  if (value.length === 0 || value.includes('\0')) {
    throw new PathContainmentError(`${label} must be a non-empty relative path.`, label);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new PathContainmentError(
      `${label} must stay inside the repository; absolute path ${JSON.stringify(value)} refused.`,
      label
    );
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith('..' + path.sep)) {
    throw new PathContainmentError(
      `${label} must stay inside the repository; ${JSON.stringify(value)} escapes upward.`,
      label
    );
  }
  return value;
}
