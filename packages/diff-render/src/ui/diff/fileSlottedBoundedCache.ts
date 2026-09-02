import type { DiffFile } from '../../core/types';

interface SlottedCacheEntry<V> {
  readonly slotKey: string;
  readonly file: WeakRef<DiffFile>;
  readonly value: V;
  readonly weight: number;
}

/**
 * A byte-budgeted LRU keyed by `(DiffFile, slotKey)` through weak per-file lookup
 * slots that are actively cleared on eviction. A WeakMap alone is not a retention
 * bound: the review's PatchIndex strongly owns its DiffFile objects for the whole
 * session, which keeps every WeakMap value alive. Entries weakly reference their
 * owning file, so the LRU retains only its priced values, never a DiffFile.
 *
 * Callers supply the slot key and the per-entry weight, and — on read — an
 * entry-validity predicate (so a slot whose stored value no longer matches the
 * caller's key / theme / generation is evicted rather than returned).
 */
export class FileSlottedBoundedCache<V> {
  readonly #slots = new WeakMap<DiffFile, Map<string, SlottedCacheEntry<V>>>();
  readonly #entries = new Map<SlottedCacheEntry<V>, true>();
  readonly #maxEntries: number;
  readonly #maxWeight: number;
  readonly #maxEntryWeight: number;
  #weight = 0;

  constructor(maxEntries: number, maxWeight: number, maxEntryWeight: number) {
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

  /**
   * Look up `(file, slotKey)`. If present and `isValid(value)`, promote it (most
   * recently used) and return the value; an invalid entry is evicted and the miss
   * reported.
   */
  get(file: DiffFile, slotKey: string, isValid: (value: V) => boolean): V | undefined {
    const entry = this.#slots.get(file)?.get(slotKey);
    if (!entry) return undefined;
    if (!isValid(entry.value)) {
      this.#remove(entry);
      return undefined;
    }
    this.#entries.delete(entry);
    this.#entries.set(entry, true);
    return entry.value;
  }

  /**
   * Insert `(file, slotKey) → value` priced at `weight`, replacing any prior entry
   * in that slot. Oversized values (beyond the per-entry or total cap) are rejected
   * without displacing existing entries; otherwise the oldest entries are evicted
   * until the cache is back within its caps.
   */
  set(file: DiffFile, slotKey: string, value: V, weight: number): boolean {
    const slots = this.#slots.get(file);
    const previous = slots?.get(slotKey);
    if (previous) this.#remove(previous);
    if (weight > this.#maxEntryWeight || weight > this.#maxWeight) return false;

    const entry: SlottedCacheEntry<V> = { slotKey, file: new WeakRef(file), value, weight };
    const nextSlots = slots ?? new Map<string, SlottedCacheEntry<V>>();
    nextSlots.set(slotKey, entry);
    this.#slots.set(file, nextSlots);
    this.#entries.set(entry, true);
    this.#weight += weight;

    while (this.#entries.size > this.#maxEntries || this.#weight > this.#maxWeight) {
      const oldest = this.#entries.keys().next().value;
      if (!oldest) break;
      this.#remove(oldest);
    }
    return this.#entries.has(entry);
  }

  #remove(entry: SlottedCacheEntry<V>) {
    if (this.#entries.delete(entry)) this.#weight -= entry.weight;
    const file = entry.file.deref();
    if (!file) return;
    const slots = this.#slots.get(file);
    if (slots?.get(entry.slotKey) !== entry) return;
    slots.delete(entry.slotKey);
    if (slots.size === 0) this.#slots.delete(file);
  }
}
