import type Database from 'better-sqlite3';
import { z } from 'zod';

import { ProjectDatabaseError } from './errors.js';
import { classifySearchMatch } from '../search-content/matching.js';

const fieldsSchema = z.strictObject({
  intent_fields: z.array(z.array(z.string())),
  body_fields: z.array(z.array(z.string())),
});

export function registerSearchFunctions(database: Database.Database): void {
  database.function('orcaops_search_match', { deterministic: true }, (fields, query) => {
    try {
      const match = classifySearchMatch(
        fieldsSchema.parse(JSON.parse(fields as string)),
        JSON.parse(query as string) as string[]
      );
      return match === null ? null : ['intent_phrase', 'text_phrase', 'all_terms'].indexOf(match);
    } catch (cause) {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Search tokens are invalid; run an explicit index rebuild before searching',
        { cause }
      );
    }
  });
}
