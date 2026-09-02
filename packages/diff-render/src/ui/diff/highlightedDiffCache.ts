import type { HighlightedDiffCode } from './pierre';

/**
 * Keep enough highlighted code for nearby file revisits without making a large review permanent.
 * The estimator is intentionally conservative: HAST nodes retain object/array structure in addition
 * to their strings, so character count alone substantially underprices real heap usage.
 */
export const MAX_HIGHLIGHT_CACHE_ENTRIES = 40;
export const MAX_HIGHLIGHT_CACHE_WEIGHT = 8 * 1024 * 1024;
export const MAX_HIGHLIGHT_CACHE_ENTRY_WEIGHT = 512 * 1024;
/** Each live HAST line keeps at most one flattened terminal-span presentation. */
export const MAX_DERIVED_HIGHLIGHT_VARIANTS_PER_LINE = 1;

const ARRAY_OVERHEAD = 32;
const ARRAY_SLOT_WEIGHT = 8;
const OBJECT_OVERHEAD = 48;
const DEFINED_LINE_FLOOR = 96;
const STRING_CODE_UNIT_WEIGHT = 2;

/** Approximate the retained bytes of one JSON-like HAST value. */
function estimateValueWeight(value: unknown, seen: Set<object>): number {
  if (value === null || value === undefined) return 0;

  if (typeof value === 'string') {
    return OBJECT_OVERHEAD + value.length * STRING_CODE_UNIT_WEIGHT;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value !== 'object' || seen.has(value)) return 0;

  seen.add(value);

  if (Array.isArray(value)) {
    let weight = ARRAY_OVERHEAD + value.length * ARRAY_SLOT_WEIGHT;
    for (const item of value) weight += estimateValueWeight(item, seen);
    return weight;
  }

  let weight = OBJECT_OVERHEAD;
  for (const [key, item] of Object.entries(value)) {
    weight += key.length * STRING_CODE_UNIT_WEIGHT;
    weight += estimateValueWeight(item, seen);
  }
  return weight;
}

/**
 * Estimate retained highlight weight, including a floor for each materialized source line.
 * The line floor captures per-line nodes/spans that share strings or otherwise look deceptively
 * cheap to a structural walk while still consuming array slots and renderer-side bookkeeping.
 */
export function estimateHighlightedDiffWeight(highlighted: HighlightedDiffCode): number {
  const lines = [...highlighted.deletionLines, ...highlighted.additionLines];
  const definedLineCount = lines.reduce((count, line) => count + (line ? 1 : 0), 0);
  const structuralWeight = estimateValueWeight(highlighted, new Set());
  return (
    ARRAY_OVERHEAD * 2 +
    lines.length * ARRAY_SLOT_WEIGHT +
    definedLineCount * DEFINED_LINE_FLOOR +
    // Flattened terminal spans are held in an ephemeron cache keyed by these HAST nodes. Price
    // their single allowed presentation as another structural copy so the LRU's byte budget also
    // covers the derived arrays, span objects, colors, and normalized text they keep alive.
    structuralWeight * (1 + MAX_DERIVED_HIGHLIGHT_VARIANTS_PER_LINE)
  );
}

interface CacheEntry {
  value: HighlightedDiffCode;
  weight: number;
}

export interface HighlightedDiffCacheOptions {
  maxEntries?: number;
  maxWeight?: number;
  maxEntryWeight?: number;
}

/** A byte-budgeted LRU for globally reusable highlighted diff results. */
export class HighlightedDiffCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #maxEntries: number;
  readonly #maxWeight: number;
  readonly #maxEntryWeight: number;
  #weight = 0;

  constructor({
    maxEntries = MAX_HIGHLIGHT_CACHE_ENTRIES,
    maxWeight = MAX_HIGHLIGHT_CACHE_WEIGHT,
    maxEntryWeight = MAX_HIGHLIGHT_CACHE_ENTRY_WEIGHT,
  }: HighlightedDiffCacheOptions = {}) {
    this.#maxEntries = maxEntries;
    this.#maxWeight = maxWeight;
    this.#maxEntryWeight = maxEntryWeight;
  }

  get size() {
    return this.#entries.size;
  }

  get weight() {
    return this.#weight;
  }

  has(key: string) {
    return this.#entries.has(key);
  }

  /** Read and promote an entry so recently revisited files survive the next eviction. */
  get(key: string) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;

    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /**
   * Cache a reusable result. Oversized results are deliberately rejected: the hook still returns
   * them to its mounted caller, but the shared cache cannot keep them alive after that view leaves.
   */
  set(key: string, value: HighlightedDiffCode) {
    const previous = this.#entries.get(key);
    if (previous) {
      this.#entries.delete(key);
      this.#weight -= previous.weight;
    }

    const weight = estimateHighlightedDiffWeight(value);
    if (weight > this.#maxEntryWeight || weight > this.#maxWeight) return false;

    this.#entries.set(key, { value, weight });
    this.#weight += weight;
    this.#enforceLimits();
    return this.#entries.has(key);
  }

  #enforceLimits() {
    while (this.#entries.size > this.#maxEntries || this.#weight > this.#maxWeight) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) return;

      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      if (oldest) this.#weight -= oldest.weight;
    }
  }
}
