#!/usr/bin/env node
/**
 * params_schema coverage lint. Walks every .eval.yaml in
 * packs/ and asserts: any spec that declares `params:` MUST also
 * declare a non-empty `params_schema:`. Without the schema, override
 * params from `.orcaops/evaluators.yaml` cannot be validated and
 * the discovery-time `params_schema_invalid` diagnostic can never
 * fire.
 *
 * Wired into the pack's pre-build step so a missing schema fails
 * fast at install/CI rather than at runtime in a user's repo.
 *
 * Exit codes:
 *   0 — every params-bearing spec has a non-empty params_schema
 *   1 — at least one spec ships params without a schema
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packsRoot = path.resolve(here, '..', 'packs');

async function* walkEvalYamls(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkEvalYamls(full);
    } else if (entry.isFile() && full.endsWith('.eval.yaml')) {
      yield full;
    }
  }
}

/**
 * Regex-based top-level key detection. We don't need a full YAML
 * parser here — the spec files are all flat-keyed (no nested objects
 * named `params`/`params_schema`) and the regex avoids adding a
 * runtime dependency to the lint script.
 *
 * Matches a top-level (column 0) key with optional content following.
 * "Non-empty schema" means there's at least one indented child line
 * under params_schema.
 */
function hasTopLevelKey(text, key) {
  return new RegExp(`^${key}\\s*:`, 'm').test(text);
}
function hasNonEmptyMapping(text, key) {
  // Match `key:` followed by at least one indented line before the
  // next top-level key or EOF.
  const re = new RegExp(`^${key}\\s*:\\s*(?:#.*)?\\n((?:[ \\t]+\\S.*\\n)+)`, 'm');
  return re.test(text);
}

const offenders = [];
for await (const yamlPath of walkEvalYamls(packsRoot)) {
  const text = await readFile(yamlPath, 'utf8');
  const hasParams = hasTopLevelKey(text, 'params');
  if (!hasParams) continue;
  const hasSchema = hasNonEmptyMapping(text, 'params_schema');
  if (!hasSchema) {
    offenders.push(path.relative(packsRoot, yamlPath));
  }
}

if (offenders.length > 0) {
  console.error(
    'params_schema coverage lint: the following specs ship `params:` without `params_schema:`'
  );
  for (const o of offenders) console.error(`  - ${o}`);
  console.error(
    '\nAdd a JSON Schema under `params_schema:` so discovery can validate override params.\n' +
      'See packages/evaluator-pack/packs/core/evaluators/plan-mentions-tests.eval.yaml for an example.'
  );
  process.exit(1);
}

console.log('params_schema coverage lint: OK');
