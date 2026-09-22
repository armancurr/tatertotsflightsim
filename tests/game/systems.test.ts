import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createSystems, discoverSystemModules, type SystemModule, type SystemContext } from '../../src/game/systems';

const ctx = {} as SystemContext;
const frame = {} as Parameters<Awaited<ReturnType<typeof createSystems>>['update']>[0];

function mod(name: string, order: number, sys: Record<string, unknown>, log?: string[]): SystemModule {
  return { name, order, create: () => { log?.push(`create:${name}`); return sys as never; } };
}

describe('systems layer', () => {
  it('discovers the built-in system modules with unique names', () => {
    const mods = discoverSystemModules();
    const names = mods.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['terrain', 'water', 'airport', 'roads', 'towns', 'vegetation', 'fx', 'audio', 'hud']));
    expect(new Set(names).size).toBe(names.length);
    const orders = mods.map((m) => m.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('creates and updates in order and skips disabled systems', async () => {
    const log: string[] = [];
    const s = await createSystems(ctx, [
      mod('b', 20, { update: () => log.push('update:b') }, log),
      mod('a', 10, { update: () => log.push('update:a') }, log),
      mod('c', 30, { update: () => log.push('update:c') }, log),
    ].sort((x, y) => x.order - y.order), new Set(['c']));
    s.update(frame);
    expect(log).toEqual(['create:a', 'create:b', 'update:a', 'update:b']);
    expect(s.names()).toEqual(['a', 'b']);
  });

  it('isolates a failing system (create or update) from the others', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    const s = await createSystems(ctx, [
      { name: 'boom', order: 1, create: () => { throw new Error('x'); } },
      mod('bad', 2, { update: () => { throw new Error('y'); } }),
      mod('good', 3, { update: ok }),
    ], new Set());
    s.update(frame);
    expect(ok).toHaveBeenCalledOnce();
    expect(s.names()).toEqual(['bad', 'good']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('uses the first readings provider and the max camera shake', async () => {
    const s = await createSystems(ctx, [
      mod('x', 1, { cameraShake: () => 0.2 }),
      mod('hud', 2, { readings: () => ({ airspeedKt: 1 }), cameraShake: () => 0.7 }),
      mod('y', 3, { readings: () => ({ airspeedKt: 2 }), cameraShake: () => Number.NaN }),
    ], new Set());
    expect(s.readings({} as never, {} as never, 0)).toEqual({ airspeedKt: 1 });
    expect(s.cameraShake({} as never)).toBe(0.7);
    const none = await createSystems(ctx, [], new Set());
    expect(none.cameraShake({} as never)).toBeNull();
    expect(none.readings({} as never, {} as never, 0)).toBeNull();
  });

  it('ready() resolves even if a system never becomes ready (timeout)', async () => {
    const s = await createSystems(ctx, [mod('slow', 1, { ready: () => new Promise(() => {}) })], new Set());
    const t0 = Date.now();
    await s.ready({} as never, 50);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('fuzz: any subset of disabled names leaves exactly the others, in order', async () => {
    const mods = ['a', 'b', 'c', 'd', 'e'].map((n, i) => mod(n, i, {}));
    await fc.assert(
      fc.asyncProperty(fc.subarray(['a', 'b', 'c', 'd', 'e']), async (off) => {
        const s = await createSystems(ctx, mods, new Set(off));
        expect(s.names()).toEqual(['a', 'b', 'c', 'd', 'e'].filter((n) => !off.includes(n)));
      }),
      { numRuns: 32 },
    );
  });
});
