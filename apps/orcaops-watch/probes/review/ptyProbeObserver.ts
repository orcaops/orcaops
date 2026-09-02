/** Read-only render-tree helpers used by real-PTY acceptance probes. */

export interface PtyProbeNode {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  plainText?: string;
  scrollTop?: number;
  scrollHeight?: number;
  viewport?: { height?: number };
  backgroundColor?: { a?: number };
  getChildren?: () => unknown[];
}

export function findPtyProbeNode(node: unknown, id: string): PtyProbeNode | null {
  const candidate = node as PtyProbeNode;
  if (candidate?.id === id) return candidate;
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findPtyProbeNode(child, id);
    if (found !== null) return found;
  }
  return null;
}

export function ptyProbeText(node: unknown): string {
  const candidate = node as PtyProbeNode;
  const pieces: string[] = [];
  if (typeof candidate?.plainText === 'string' && candidate.plainText.length > 0) {
    pieces.push(candidate.plainText);
  }
  for (const child of candidate?.getChildren?.() ?? []) {
    const text = ptyProbeText(child);
    if (text.length > 0) pieces.push(text);
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

export function ptyProbeNodeLine(id: string, node: PtyProbeNode | null): string {
  if (node === null) return `NODE id=${id} present=0`;
  return [
    `NODE id=${id}`,
    'present=1',
    `x=${Math.floor(node.x ?? -1)}`,
    `y=${Math.floor(node.y ?? -1)}`,
    `width=${Math.floor(node.width ?? -1)}`,
    `height=${Math.floor(node.height ?? -1)}`,
    `alpha=${node.backgroundColor?.a ?? -1}`,
  ].join(' ');
}
