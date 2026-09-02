import { describe, expect, it, vi } from 'vitest';

import { GenerationProjectionCache, retainProjection } from './generationProjectionCache';

describe('GenerationProjectionCache', () => {
  it('builds the model and reader once for one immutable generation object', () => {
    const buildModel = vi.fn((input: { value: number }) => ({ doubled: input.value * 2 }));
    const buildReader = vi.fn((_input, model: { doubled: number }) => ({ page: model.doubled }));
    const cache = new GenerationProjectionCache(buildModel, buildReader);
    const generation = { value: 21 };

    const beforePublish = cache.project(generation);
    const duringRender = cache.project(generation);

    expect(duringRender).toBe(beforePublish);
    expect(duringRender).toEqual({ model: { doubled: 42 }, reader: { page: 42 } });
    expect(buildModel).toHaveBeenCalledTimes(1);
    expect(buildReader).toHaveBeenCalledTimes(1);
  });

  it('reprojects an immutable replacement even when its content is equal', () => {
    const buildModel = vi.fn((input: { value: number }) => input.value);
    const buildReader = vi.fn((_input, model: number) => model);
    const cache = new GenerationProjectionCache(buildModel, buildReader);

    cache.project({ value: 1 });
    cache.project({ value: 1 });

    expect(buildModel).toHaveBeenCalledTimes(2);
    expect(buildReader).toHaveBeenCalledTimes(2);
  });
});

describe('retainProjection', () => {
  it('does no inactive-lens work and builds at most once when selected', () => {
    const build = vi.fn(() => ({ pages: 3 }));
    const retained = retainProjection(build);

    expect(build).not.toHaveBeenCalled();
    const selected = retained();
    expect(retained()).toBe(selected);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
