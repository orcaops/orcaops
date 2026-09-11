import { z } from 'zod';
export const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isUuidV7(s: string): boolean {
  return UUID_V7_REGEX.test(s);
}
export const UuidV7Schema = z
  .string()
  .refine(isUuidV7, { message: 'must be a canonical lowercase UUIDv7' });
