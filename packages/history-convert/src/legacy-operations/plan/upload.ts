import { z } from 'zod';
export const UploadsIndexEntrySchema = z.object({
  fingerprint: z.string().min(1),
  external_id: z.string().min(1),
  unresolved: z.array(z.string()).default([]),
});
