/**
 * One immutable loaded-generation object gets one model/reader projection.
 *
 * ReviewApp needs the projection before publishing a generation so it can
 * reconcile the cursor, and React needs the same projection while rendering.
 * Without a generation-keyed cache those two consumers independently rebuild
 * the full synthesized model and reader. Weak keys keep the cache bounded by
 * the generations the app still retains.
 */
export class GenerationProjectionCache<Input extends object, Model, Reader> {
  readonly #cache = new WeakMap<Input, { readonly model: Model; readonly reader: Reader }>();

  constructor(
    private readonly buildModel: (input: Input) => Model,
    private readonly buildReader: (input: Input, model: Model) => Reader
  ) {}

  project(input: Input): { readonly model: Model; readonly reader: Reader } {
    const existing = this.#cache.get(input);
    if (existing !== undefined) return existing;
    const model = this.buildModel(input);
    const projection = { model, reader: this.buildReader(input, model) };
    this.#cache.set(input, projection);
    return projection;
  }
}

/** Build a projection only on first use, then retain it for one generation. */
export function retainProjection<Value>(build: () => Value): () => Value {
  let retained: { readonly value: Value } | null = null;
  return () => {
    retained ??= { value: build() };
    return retained.value;
  };
}
