import { type Config, configVersionForWrite, getDefaultConfig } from '@orcaops/storage';

/**
 * Returns `undefined` when `actual` deep-equals `defaults`; otherwise the
 * minimal structure of differing keys (leaves and arrays compare by JSON).
 */
function diffValue(actual: unknown, defaults: unknown): unknown | undefined {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isPlainObject(actual) || !isPlainObject(defaults)) {
    return JSON.stringify(actual) === JSON.stringify(defaults) ? undefined : actual;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    const d = diffValue(actual[key], defaults[key]);
    if (d !== undefined) out[key] = d;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The MINIMAL config document init writes: only keys that differ from
 * `getDefaultConfig()`, plus three always-pinned anchors —
 *
 * - `schema_version`: always pinned so the document self-identifies its
 *   shape — an unversioned config forces every consumer to guess;
 * - `install.agents` + `install.scope`: init's actively-decided keys stay
 *   visible even when they happen to equal the defaults — on team adoption
 *   the committed config must carry an EXPLICIT scope so older CLIs never
 *   depend on a default that this CLI just flipped;
 * - `bootstrap`: same reasoning (fresh init overrides the schema default).
 *
 * Everything else rides zod defaults, so the document a team later commits
 * is a ~10-line file portable across CLI versions instead of a pin of every
 * default value at install time.
 *
 * `existingVersion` is the `schema_version` of the file being re-minimized;
 * omit it for a fresh file. A preserved file keeps its version unless the
 * delta carries a key that version cannot read, so re-initializing with a newer
 * CLI does not lock teammates on an older one out of a committed config.
 */
export function buildConfigDelta(
  config: Config,
  existingVersion?: unknown
): Record<string, unknown> {
  const delta = (diffValue(config, getDefaultConfig()) ?? {}) as Record<string, unknown>;
  const { schema_version: _sv, install: deltaInstall, bootstrap: _b, ...rest } = delta;
  const document = {
    install: {
      agents: config.install.agents,
      scope: config.install.scope,
      ...(typeof deltaInstall === 'object' && deltaInstall !== null ? deltaInstall : {}),
    },
    bootstrap: config.bootstrap,
    ...rest,
  };
  return { schema_version: configVersionForWrite(document, existingVersion), ...document };
}
