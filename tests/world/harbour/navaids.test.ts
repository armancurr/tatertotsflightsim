/**
 * Aids to navigation (src/world/harbour/navaids.ts): light characters as charted, the Gull Island
 * lighthouse's rotating optic showing Fl(2) W 10s from every bearing, the lateral buoys on the right
 * sides of each channel (IALA A: red to port entering from seaward), the safe-water and cardinal
 * marks, and every buoy in open water clear of the traffic, the berths, the piers and the other
 * builders' areas (jet-ski course, wind farm, oil rig, gunnery range).
 */
import { describe, it, expect } from 'vitest';
import { getLayout } from '../../../src/world/layout';
import { getHeightfield } from '../../../src/world/heightfield';
import {
  navaids, parseLight, lightOn, lighthouseIntensity, lighthouseBeamAzimuth, channelSide, LIGHT_TIMING, type Buoy,
} from '../../../src/world/harbour/navaids';
import { portBerths, portMarina, seaDepth, seaStart } from '../../../src/world/port';
import { portWorks } from '../../../src/world/harbour/layout';
import { createPortObstacles } from '../../../src/world/harbour/obstacles';
import { createSeaPlan, marinaStructureDistance, toLocal } from '../../../src/world/traffic/sea';
import { samplePath, newPathSample } from '../../../src/world/traffic/path';

const hf = getHeightfield();
const water = { groundHeight: (x: number, z: number) => hf.height(x, z), waterLevel: (x: number, z: number) => hf.waterLevel(x, z) };
const layout = getLayout();
const n = navaids(layout);
const DEG = Math.PI / 180;

/** Flash start times (s) and lengths of a boolean signal sampled every dt over [0, T). */
function flashes(on: (t: number) => boolean, T: number, dt = 0.005): { start: number; len: number }[] {
  const out: { start: number; len: number }[] = [];
  // (a flash already showing at t = 0 is not counted: its start is unknown)
  let was = on(-dt);
  let start = NaN;
  for (let t = 0; t < T; t += dt) {
    const v = on(t);
    if (v && !was) start = t;
    if (!v && was && Number.isFinite(start)) out.push({ start, len: t - start });
    was = v;
  }
  return out;
}

describe('light characters', () => {
  it('parses what a chart writes', () => {
    const fl = parseLight('Fl R 4s');
    expect(fl).toMatchObject({ color: 'R', period: 4, on: [[0, LIGHT_TIMING.flash]] });
    const fl2 = parseLight('Fl(2) W 10s');
    expect(fl2.on).toEqual([[0, 0.5], [1.5, 2]]);
    expect(parseLight('LFl W 10s').on).toEqual([[0, 2]]);
    expect(parseLight('Q W')).toMatchObject({ period: 1, on: [[0, 0.35]] });
    expect(parseLight('Q(3) W 10s').on).toHaveLength(3);
    const s = parseLight('Q(6)+LFl W 15s');
    expect(s.on).toHaveLength(7);
    expect(s.on[6][1] - s.on[6][0]).toBe(2);
    expect(parseLight('Q(9) W 15s').on).toHaveLength(9);
    expect(parseLight('Iso W 4s').on).toEqual([[0, 2]]);
    expect(parseLight('F G').on).toEqual([[0, 1]]);
    expect(() => parseLight('Fl(9) W 5s')).toThrow();
    expect(() => parseLight('blink')).toThrow();
  });

  it('lightOn flashes with the character (and a phase shift moves it)', () => {
    const ch = parseLight('Fl(3) G 10s');
    const f = flashes((t) => lightOn(ch, t), 30);
    expect(f).toHaveLength(9);
    expect(f.map((x) => Math.round(x.start * 10) / 10).slice(0, 4)).toEqual([0, 1.5, 3, 10]);
    for (const x of f) expect(x.len).toBeCloseTo(0.5, 1);
    expect(lightOn(ch, 0.2)).toBe(true);
    expect(lightOn(ch, 0.2, 0.5)).toBe(false);
    expect(lightOn(ch, -9.8)).toBe(true); // negative times wrap
  });
});

describe('the Gull Island lighthouse', () => {
  const lh = n.lighthouse;

  it('stands on the island\'s summit, its light ~175 m up', () => {
    const gull = layout.islands.find((i) => i.name === 'Gull Island')!;
    expect(Math.hypot(lh.x - gull.x, lh.z - gull.z)).toBeLessThan(gull.radius * 0.6 + 1);
    expect(hf.waterLevel(lh.x, lh.z)).toBeNull();
    expect(lh.groundY).toBeGreaterThan(100);
    expect(lh.focalY - lh.groundY).toBeGreaterThan(18);
    // nothing on the island is much higher
    for (let a = 0; a < 360; a += 15) for (const r of [100, 250, 400]) expect(hf.height(lh.x + r * Math.cos(a * DEG), lh.z + r * Math.sin(a * DEG))).toBeLessThan(lh.groundY + 4);
    expect(lh.character.label).toBe('Fl(2) W 10s');
  });

  it('its rotating optic shows Fl(2) W 10s from every bearing: two flashes 1.5 s apart every 10 s', () => {
    for (let b = 0; b < 360; b += 17) {
      const f = flashes((t) => lighthouseIntensity(lh, t, b) > 0.5, 30.001, 0.002);
      expect(f.length, `bearing ${b}`).toBeGreaterThanOrEqual(5);
      // group into pairs: gaps alternate 1.5 s and 8.5 s
      const starts = f.map((x) => x.start);
      const gaps = starts.slice(1).map((s, i) => s - starts[i]);
      for (const g of gaps) expect(Math.min(Math.abs(g - 1.5), Math.abs(g - 8.5)), `bearing ${b}: gap ${g}`).toBeLessThan(0.05);
      for (const x of f) {
        expect(x.len).toBeGreaterThan(0.2);
        expect(x.len).toBeLessThan(0.6);
      }
    }
    // the character's own flashes are the same timing
    const c = lh.character;
    expect(c.on[1][0] - c.on[0][0]).toBeCloseTo(1.5, 6);
    expect(c.period).toBe(lh.rotationS);
  });

  it('the beam turns clockwise, once per 10 s; between flashes the lantern glows dimly', () => {
    expect(lighthouseBeamAzimuth(lh, 0)).toBe(0);
    expect(lighthouseBeamAzimuth(lh, 2.5)).toBeCloseTo(90, 6);
    expect(lighthouseBeamAzimuth(lh, 12.5)).toBeCloseTo(90, 6);
    expect(lighthouseIntensity(lh, 2.5, 90)).toBeCloseTo(1, 2);
    expect(lighthouseIntensity(lh, 2.5, 270)).toBeLessThan(0.1);
    expect(lighthouseIntensity(lh, 2.5, 270)).toBeGreaterThan(0);
  });
});

describe('buoys', () => {
  const buoys = n.buoys;
  const byKind = (k: Buoy['kind']) => buoys.filter((b) => b.kind === k);

  it('lateral marks on the right sides (IALA A: red cans to port, green cones to starboard entering from seaward)', () => {
    expect(byKind('port').length).toBeGreaterThanOrEqual(6);
    expect(byKind('starboard').length).toBe(byKind('port').length);
    for (const ch of n.channels) {
      const lat = buoys.filter((b) => b.group === ch.id);
      expect(lat.length, ch.id).toBeGreaterThanOrEqual(4);
      for (const b of lat) {
        expect(channelSide(ch, b.x, b.z), b.id).toBe(b.kind === 'starboard' ? 1 : -1);
        expect(b.character.color, b.id).toBe(b.kind === 'port' ? 'R' : 'G');
      }
    }
  });

  it('each channel leads in from seaward toward its berth or entrance', () => {
    const b = portBerths(layout);
    const m = portMarina(layout);
    const target = { marina: { x: m.frame.ox + m.frame.wx * m.entrance.w, z: m.frame.oz + m.frame.wz * m.entrance.w }, cruise: { x: b.cruise.face.cx, z: b.cruise.face.cz }, naval: { x: b.naval.face.cx, z: b.naval.face.cz } };
    for (const ch of n.channels) {
      const t = target[ch.id];
      expect(Math.hypot(ch.to.x - t.x, ch.to.z - t.z)).toBeLessThan(Math.hypot(ch.from.x - t.x, ch.from.z - t.z));
      // seaward = farther from the coast
      expect(ch.from.z - layout.coast.zAt(ch.from.x)).toBeGreaterThan(ch.to.z - layout.coast.zAt(ch.to.x));
    }
  });

  it('a red-and-white safe-water mark at the fairway, seaward of the marina channel', () => {
    const s = byKind('safe');
    expect(s).toHaveLength(1);
    expect(s[0].character.label).toBe('LFl W 10s');
    const m = portMarina(layout);
    expect(toLocal(m.frame, s[0].x, s[0].z).w).toBeGreaterThan(1200);
  });

  it('cardinal marks on the islands\' shoals: on their own side of the hazard, in ≥ 6 m of water, with the IALA characters', () => {
    const chars = { north: 'Q W', east: 'Q(3) W 10s', south: 'Q(6)+LFl W 15s', west: 'Q(9) W 15s' } as const;
    let count = 0;
    for (const k of ['north', 'east', 'south', 'west'] as const) {
      for (const b of byKind(k)) {
        count++;
        const isl = layout.islands.find((i) => i.name === b.group)!;
        const brg = ((Math.atan2(b.x - isl.x, -(b.z - isl.z)) / DEG) + 360) % 360;
        const want = { north: 0, east: 90, south: 180, west: 270 }[k];
        expect(Math.abs(((brg - want + 540) % 360) - 180), b.id).toBeLessThan(1);
        expect(Math.hypot(b.x - isl.x, b.z - isl.z)).toBeGreaterThan(isl.radius);
        expect(seaDepth(water, b.x, b.z), b.id).toBeGreaterThanOrEqual(6);
        expect(b.character.label).toBe(chars[k]);
      }
    }
    expect(count).toBeGreaterThanOrEqual(8);
    // Gull Island is marked all round
    expect(buoys.filter((b) => b.group === 'Gull Island').map((b) => b.kind).sort()).toEqual(['east', 'north', 'south', 'west']);
  });

  it('every buoy floats in open water, clear of the berths, the piers and the marina', () => {
    const po = createPortObstacles(portWorks(layout));
    const berths = portBerths(layout);
    const m = portMarina(layout);
    const inPoly = (p: { x: number; z: number }, poly: { x: number; z: number }[]) => {
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const c = poly[(i + 1) % poly.length];
        s += Math.sign((c.x - a.x) * (p.z - a.z) - (c.z - a.z) * (p.x - a.x));
      }
      return Math.abs(s) === poly.length;
    };
    for (const b of buoys) {
      expect(seaDepth(water, b.x, b.z), b.id).toBeGreaterThan(4);
      for (const site of Object.values(berths)) expect(inPoly(b, site.reserved), `${b.id} in ${site.id}`).toBe(false);
      for (let a = 0; a < 360; a += 30) expect(po.top(b.x + 40 * Math.cos(a * DEG), b.z + 40 * Math.sin(a * DEG)), b.id).toBe(-Infinity);
      expect(marinaStructureDistance(m, b.x, b.z), b.id).toBeGreaterThan(40);
    }
    // distinct: no two buoys within 100 m
    for (let i = 0; i < buoys.length; i++) for (let j = i + 1; j < buoys.length; j++) expect(Math.hypot(buoys[i].x - buoys[j].x, buoys[i].z - buoys[j].z)).toBeGreaterThan(100);
  });

  it('and out of the other builders\' areas: the jet-ski course, the wind farm, the oil rig, the gunnery range; far from the sea start', () => {
    const s = seaStart(layout);
    for (const b of buoys) {
      expect(b.x >= -3000 - 100 && b.x <= -1700 + 100 && b.z >= 7700 - 100 && b.z <= 8300 + 100, `${b.id} in the jet-ski course`).toBe(false);
      expect(b.x >= 9000 - 200 && b.x <= 13500 + 200 && b.z >= 9600 - 200 && b.z <= 12000 + 200, `${b.id} in the wind farm`).toBe(false);
      expect(Math.hypot(b.x - 5200, b.z - 12800), `${b.id} by the oil rig`).toBeGreaterThan(1000);
      expect(Math.hypot(b.x + 15500, b.z - 13200), `${b.id} on the gunnery range`).toBeGreaterThan(3000);
      expect(Math.hypot(b.x - s.x, b.z - s.z), b.id).toBeGreaterThan(300);
    }
  });

  it('no traffic route passes within 60 m of a buoy', () => {
    const plan = createSeaPlan(layout, water);
    expect(plan.rejected).toEqual([]);
    const sm = newPathSample();
    for (const r of plan.routes) {
      if (r.level > 1) continue;
      const step = r.path.length > 50000 ? 40 : 8;
      for (let d = 0; d < r.path.length; d += step) {
        samplePath(r.path, d, sm);
        for (const b of buoys) {
          if (Math.abs(sm.x - b.x) > 200 || Math.abs(sm.z - b.z) > 200) continue;
          expect(Math.hypot(sm.x - b.x, sm.z - b.z), `${r.id} near ${b.id}`).toBeGreaterThan(60);
        }
      }
    }
  }, 60_000);

  it('the harbour lights on the breakwater heads: red to port, green to starboard entering, flashing', () => {
    const m = portMarina(layout);
    expect(n.harbourLights).toHaveLength(2);
    for (const l of n.harbourLights) {
      const { u } = toLocal(m.frame, l.x, l.z);
      // entering (heading −w), +u is to starboard
      expect(l.character.color).toBe(u > 0 ? 'G' : 'R');
      expect(l.character.label).toMatch(/^Fl [RG] 4s$/);
    }
  });
});
