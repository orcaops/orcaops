export { BASELINE_SCHEMA, BASELINE_VERSION } from './025-baseline.js';
import { BASELINE_VERSION } from './025-baseline.js';

/**
 * The baseline is the whole schema, and later baselines replace it whole.
 * The runner in `store/sqlite.ts` initializes fresh
 * databases at this version and rejects other existing cache versions.
 * Version numbers are never recycled.
 */
export const CURRENT_VERSION = BASELINE_VERSION;
