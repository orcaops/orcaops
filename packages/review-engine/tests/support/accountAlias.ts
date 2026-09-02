/**
 * Test support for the account projection's citation-id ALIAS STRIP — the
 * inverse of `applyStrip` in `dossier.ts`, which rewrites the artifact uuid
 * inside every id the projection serves (`cite:<uuid>:cp1:decision:0` ->
 * `cite:a1:cp1:decision:0`) and the bare `artifact` field of every projected
 * checkpoint. Undoing it is what lets a test compare the SERVED account core
 * against the CAPTURED one on equal terms.
 *
 * Lives here rather than inline in one test because two suites need it:
 * `dossierRoutine.test.ts` (protected-corpus fidelity) and `dossier.test.ts`
 * (captured-fixture id round-trip). No vitest import — pure functions only, so the
 * package build stays free of test-framework references.
 */

import type { AccountProjection } from '../../src/dossier.js';
import { buildAccountPromptAliases } from '../../src/twolaneSlice.js';

/** The alias table as `AccountProjection` publishes it: alias -> artifact uuid. */
export type ArtifactAliases = Readonly<Record<string, string>>;

/** Private alias maps the engine uses to compile model-authored documents. */
export interface AccountPromptAliasMaps {
  checkpoints: ReadonlyMap<string, string>;
  citations: ReadonlyMap<string, string>;
}

/**
 * Derive the same private `k#`/`c#` maps as the compiler. The renderer no
 * longer publishes a second lookup table; aliases appear only beside the
 * records they identify.
 */
export function accountPromptAliasMaps(projection: AccountProjection): AccountPromptAliasMaps {
  const aliases = buildAccountPromptAliases(projection);
  return {
    checkpoints: new Map(aliases.checkpoints.map((entry) => [entry.alias, entry.canonical])),
    citations: new Map(aliases.citations.map((entry) => [entry.alias, entry.canonical])),
  };
}

/** Find the prompt alias assigned to one canonical citation id. */
export function promptCitationAlias(
  projection: AccountProjection,
  canonical: string
): string | undefined {
  for (const [alias, id] of accountPromptAliasMaps(projection).citations)
    if (id === canonical) return alias;
  return undefined;
}

/**
 * Undo the alias strip on ONE id. Citation ids carry the artifact between
 * colons; a projected checkpoint's `artifact` field carries the bare alias.
 */
export function unaliasCitationId(id: string, aliases: ArtifactAliases): string {
  for (const [alias, uuid] of Object.entries(aliases)) {
    if (id === alias) return uuid;
    if (id.includes(`:${alias}:`)) return id.replace(`:${alias}:`, `:${uuid}:`);
  }
  return id;
}

/** Account-core keys whose string values are ids rather than captured prose. */
const ID_KEYS: ReadonlySet<string> = new Set(['citationId', 'parent', 'artifact']);

/**
 * Deep-undo the alias strip across a projected account-core value.
 *
 * Rewrites only the keys that HOLD ids, never arbitrary strings that happen to
 * look like one. Two reasons: a captured `text` reading `a1` must survive
 * verbatim, and a future protected field carrying ids under a new key name must
 * FAIL a fidelity deep-equal loudly (alias on one side, uuid on the other)
 * instead of being silently normalized into agreement.
 */
export function unaliasAccountValue<T>(value: T, aliases: ArtifactAliases): T {
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string')
      return key !== null && ID_KEYS.has(key) ? unaliasCitationId(node, aliases) : node;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node !== null && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    return node;
  };
  return walk(value, null) as T;
}
