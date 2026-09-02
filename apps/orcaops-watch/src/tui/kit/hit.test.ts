import { describe, expect, it } from 'vitest';

import { HitCoordinator } from './hit';

describe('HitCoordinator', () => {
  it('arms on down and commits only the same stable hit on release', () => {
    const hit = new HitCoordinator(() => 100);

    expect(hit.arm('row:a')).toBe(true);
    expect(hit.isArmed('row:a')).toBe(true);
    expect(hit.release('row:b')).toEqual({ committed: false, double: false });
    expect(hit.release('row:a')).toEqual({ committed: false, double: false });

    hit.arm('row:a');
    expect(hit.release('row:a')).toEqual({ committed: true, double: false });
  });

  it('keeps disabled hits inert and lets cancellation fence trailing modal events', () => {
    const hit = new HitCoordinator(() => 100);

    expect(hit.arm('disabled', false)).toBe(false);
    expect(hit.release('disabled', false)).toEqual({ committed: false, double: false });

    hit.arm('underlay');
    hit.cancel();
    expect(hit.release('underlay')).toEqual({ committed: false, double: false });
  });

  it('detects one bounded same-hit double activation with an injected clock', () => {
    let now = 1_000;
    const hit = new HitCoordinator(() => now, 300);
    const click = (id: string) => {
      hit.arm(id);
      return hit.release(id);
    };

    expect(click('row:a')).toEqual({ committed: true, double: false });
    now += 250;
    expect(click('row:a')).toEqual({ committed: true, double: true });
    now += 20;
    expect(click('row:a')).toEqual({ committed: true, double: false });
    now += 310;
    expect(click('row:a')).toEqual({ committed: true, double: false });
    now += 20;
    expect(click('row:b')).toEqual({ committed: true, double: false });
  });

  it('clears a virtualized target arm when that identity unmounts', () => {
    const hit = new HitCoordinator(() => 100);
    hit.arm('virtual:42');
    hit.cancel('virtual:42');
    expect(hit.release('virtual:42')).toEqual({ committed: false, double: false });
  });
});
