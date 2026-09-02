import { describe, expect, it } from 'vitest';

import { buildFileRenderWindow } from './fileRenderWindow';
import type { FileSectionLayout } from './fileSectionLayout';

function sections(count: number, height = 100): FileSectionLayout[] {
  return Array.from({ length: count }, (_unused, sectionIndex) => ({
    fileId: `src/file-${sectionIndex}.ts`,
    sectionIndex,
    sectionTop: sectionIndex * height,
    headerTop: sectionIndex * height,
    bodyTop: sectionIndex * height + 3,
    bodyHeight: height - 4,
    sectionBottom: (sectionIndex + 1) * height,
  }));
}

describe('buildFileRenderWindow', () => {
  it('treats the viewport as half-open at exact section boundaries', () => {
    const plan = buildFileRenderWindow({
      fileSectionLayouts: sections(4),
      scrollTop: 100,
      viewportHeight: 100,
      overscanFiles: 0,
    });

    expect(plan.mountedFileIndices).toEqual([1]);
    expect(plan.visibleStartIndex).toBe(1);
    expect(plan.visibleEndIndex).toBe(1);
  });

  it('mounts no section for an empty viewport', () => {
    const plan = buildFileRenderWindow({
      fileSectionLayouts: sections(2),
      scrollTop: 100,
      viewportHeight: 0,
      overscanFiles: 0,
    });

    expect(plan.mountedFileIndices).toEqual([]);
  });
});
