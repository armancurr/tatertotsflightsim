/**
 * Gun visuals (built in node, no WebGL): the glow-streak buffer (tracers + muzzle flash), which
 * rounds become tracers and how they burn out, the gun-gas emitter, the ?targets=test set, and the
 * weapons system module. Unit + fast-check fuzz.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createGlowRenderer, type GlowSink } from '../../src/combat/render/glow';
import { writeTracers, writeMuzzleFlash, BURN_END_S, STREAK_MAX_M } from '../../src/combat/render/tracers';
import { createGunGasState, emitGunGas } from '../../src/combat/render/gunGas';
import { RoundPool, ROUND_TRACER, ROUND_HEI } from '../../src/combat/rounds';
import { testTargets, TEST_GROUP } from '../../src/combat/testTargets';
import { ParticlePool } from '../../src/fx/pool';
import { createRng } from '../../src/combat/rng';
import { FLAT_ENV } from '../../src/physics';
import weaponsSystem from '../../src/game/systems/weapons';
import { fcParams } from '../support/fc';
import { FxSim } from '../../src/fx/sim';

function recordSink() {
  const rows: number[][] = [];
  const sink: GlowSink = { add: (...a) => (rows.push(a), true) };
  return { rows, sink };
}

function poolWith(n: number, flags: (i: number) => number, age = 0.5) {
  const p = new RoundPool(64);
  for (let i = 0; i < n; i++) {
    const s = p.spawn();
    p.x[s] = i; p.y[s] = 100; p.z[s] = -10 * i;
    p.vx[s] = 0; p.vy[s] = 0; p.vz[s] = -900;
    p.flags[s] = flags(i);
    p.age[s] = age;
  }
  return p;
}

describe('tracers and muzzle flash', () => {
  it('only tracer rounds are drawn, as streaks trailing back along the velocity', () => {
    const { rows, sink } = recordSink();
    const p = poolWith(12, (i) => (i % 4 === 0 ? ROUND_TRACER : 0) | (i % 5 === 2 ? ROUND_HEI : 0));
    expect(writeTracers(p, sink)).toBe(3);
    for (const r of rows) {
      const [hx, hy, hz, tx, ty, tz] = r;
      expect(hx).toBe(tx);
      expect(hy).toBe(ty);
      expect(tz - hz).toBeGreaterThan(5); // tail behind (+z) a round flying −z
      expect(tz - hz).toBeLessThanOrEqual(STREAK_MAX_M + 1e-9);
    }
  });

  it('tracers burn out after ~3 s of flight', () => {
    const { sink } = recordSink();
    expect(writeTracers(poolWith(4, () => ROUND_TRACER, BURN_END_S + 0.1), sink)).toBe(0);
    const { rows, sink: s2 } = recordSink();
    writeTracers(poolWith(1, () => ROUND_TRACER, (BURN_END_S + 2.6) / 2), s2);
    expect(rows[0][7]).toBeGreaterThan(0);
    expect(rows[0][7]).toBeLessThan(1);
  });

  it('the muzzle flash is two streaks at the muzzle pointing along the gun line', () => {
    const { rows, sink } = recordSink();
    writeMuzzleFlash(sink, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: -1 }, 0.5);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r[3]).toBe(1); // tail at the muzzle
      expect(r[5]).toBe(3);
      expect(r[2]).toBeLessThan(3); // head ahead (−z)
    }
  });

  it('the glow buffer caps at its capacity; the mesh stays in the scene with 0 instances when idle (no first-shot shader hitch)', () => {
    const scene = new THREE.Scene();
    const g = createGlowRenderer(scene, 3);
    expect(scene.getObjectByName('weapons-glow')).toBe(g.mesh);
    g.begin();
    for (let i = 0; i < 5; i++) g.add(0, 0, -i, 0, 0, 1 - i, 0.1, 1, 1, 1, 1, 1);
    expect(g.count).toBe(3);
    g.end(1440, 900);
    expect(g.mesh.visible).toBe(true);
    expect((g.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(3);
    g.begin();
    g.end(1440, 900);
    expect(g.mesh.visible).toBe(true);
    expect((g.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
    g.dispose();
    expect(scene.getObjectByName('weapons-glow')).toBeUndefined();
  });

  it('fuzz: non-finite streaks are skipped, never written', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Infinity)), { minLength: 8, maxLength: 8 }), (v) => {
        const g = createGlowRenderer(null, 4);
        g.begin();
        g.add(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], 1, 1, 1, 1);
        const finite = v.every((x) => Number.isFinite(x)) && Number.isFinite(v.reduce((a, b) => a + b, 0));
        expect(g.count).toBe(finite ? 1 : 0);
        g.dispose();
      }),
      fcParams(200),
    );
  });
});

describe('gun gas', () => {
  it('pours ~48 puffs/s of grey smoke from the muzzle once a burst is under way, fewer at its start', () => {
    const pool = new ParticlePool(2000);
    const rng = createRng(3);
    const src = { smoke: pool, rnd: () => rng.next() };
    const st = createGunGasState();
    let early = 0;
    for (let i = 0; i < 6; i++) early += emitGunGas(src, st, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -120 }, 1 / 60, i / 60);
    let full = 0;
    for (let i = 0; i < 60; i++) full += emitGunGas(src, st, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -120 }, 1 / 60, 1 + i / 60);
    expect(full).toBeGreaterThan(40);
    expect(full).toBeLessThan(56);
    expect(early / 6).toBeLessThan(full / 60);
    expect(pool.count).toBe(early + full);
    // Emitted ahead of / at the muzzle, moving with the aircraft plus the gas jet.
    for (let i = 0; i < pool.capacity; i++) {
      if (!pool.alive[i]) continue;
      expect(pool.pz[i]).toBeLessThanOrEqual(0.5);
      expect(pool.vz[i]).toBeLessThan(-120);
    }
  });

  it('emits into the real fx simulation (its rnd is a method: must stay bound)', () => {
    const sim = new FxSim(5);
    const st = createGunGasState();
    let n = 0;
    for (let i = 0; i < 30; i++) n += emitGunGas(sim, st, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -120 }, 1 / 60, 1);
    expect(n).toBeGreaterThan(15);
    expect(sim.smoke.count).toBe(n);
  });

  it('a 20 mm gun makes a smaller cloud, and no time step = no gas', () => {
    const pool = new ParticlePool(500);
    const rng = createRng(4);
    const src = { smoke: pool, rnd: () => rng.next() };
    let a = 0, b = 0;
    const s1 = createGunGasState(), s2 = createGunGasState();
    for (let i = 0; i < 120; i++) {
      a += emitGunGas(src, s1, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 }, 1 / 60, 2, 30);
      b += emitGunGas(src, s2, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 }, 1 / 60, 2, 20);
    }
    expect(b).toBeLessThan(a * 0.6);
    expect(emitGunGas(src, s1, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 }, 0, 2)).toBe(0);
  });
});

describe('?targets=test and the system module', () => {
  it('places six vehicles on the ground around the range, one of them driving', () => {
    const list = testTargets({ x: 100, z: -5000, headingDeg: 350 }, FLAT_ENV);
    expect(list).toHaveLength(6);
    expect(new Set(list.map((t) => t.kind))).toEqual(new Set(['tank', 'ifv', 'truck']));
    for (const t of list) {
      expect(t.group).toBe(TEST_GROUP);
      expect(t.position.y).toBe(0);
      expect(Math.hypot(t.position.x - 100, t.position.z + 5000)).toBeLessThan(250);
    }
    expect(list.filter((t) => t.velocity && Math.hypot(t.velocity.x, t.velocity.z) > 1)).toHaveLength(1);
    expect(testTargets(null, FLAT_ENV)[0].position.z).toBe(-7000);
  });

  it('the weapons system runs between the scenery and the fx', () => {
    expect(weaponsSystem.name).toBe('weapons');
    expect(weaponsSystem.order).toBeGreaterThan(61);
    expect(weaponsSystem.order).toBeLessThan(80);
  });
});
