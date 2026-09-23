/**
 * Deferred disposal (src/game/deferredDispose.ts): the old aircraft's GPU resources are freed a couple
 * of rendered frames after it left the scene (see the file header for the three.js shadow-material
 * reason), never lost, never run twice, and a throwing dispose doesn't stop the others.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createDeferredDisposer } from '../../src/game/deferredDispose';
import { fcParams } from '../support/fc';

describe('deferred disposal', () => {
  it('runs on the n-th following frame, not before', () => {
    const d = createDeferredDisposer();
    let ran = 0;
    d.defer(() => ran++, 2);
    d.tick();
    expect(ran).toBe(0);
    d.tick();
    expect(ran).toBe(1);
    d.tick();
    expect(ran).toBe(1);
    expect(d.pending).toBe(0);
  });

  it('flush() runs everything pending at once (app shutdown)', () => {
    const d = createDeferredDisposer();
    const order: number[] = [];
    d.defer(() => order.push(1), 5);
    d.defer(() => order.push(2), 9);
    d.flush();
    expect(order).toEqual([1, 2]);
    d.tick();
    expect(order).toEqual([1, 2]);
  });

  it('a throwing dispose is reported and the rest still run', () => {
    const errors: unknown[] = [];
    const d = createDeferredDisposer((e) => errors.push(e));
    let ok = 0;
    d.defer(() => {
      throw new Error('bad');
    }, 1);
    d.defer(() => ok++, 1);
    d.tick();
    expect(errors).toHaveLength(1);
    expect(ok).toBe(1);
  });

  it('property: every deferred job runs exactly once, no earlier than asked, whatever the interleaving', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.record({ defer: fc.integer({ min: -2, max: 6 }) }), fc.constant({ tick: true })), { maxLength: 80 }), (ops) => {
        const d = createDeferredDisposer();
        const runs: number[] = [];
        const wantAt: number[] = [];
        let frame = 0;
        for (const op of ops) {
          if ('tick' in op) {
            frame++;
            d.tick();
          } else {
            const id = wantAt.length;
            wantAt.push(frame + Math.max(1, op.defer));
            runs.push(-1);
            d.defer(() => {
              expect(runs[id]).toBe(-1);
              runs[id] = frame;
            }, op.defer);
          }
        }
        for (let i = 0; i < runs.length; i++) if (runs[i] >= 0) expect(runs[i]).toBeGreaterThanOrEqual(wantAt[i]);
        d.flush();
        expect(runs.every((r) => r >= 0)).toBe(true);
        expect(d.pending).toBe(0);
      }),
      fcParams(200),
    );
  });
});
