/**
 * The player's wake and spray (vessels only: a def with `kind: 'vessel'` / a `watercraft` config),
 * for any vessel — a jet ski, the V50, a cruise ship or a battleship — sized from its station table
 * (length, beam) and driven by its state (speed through the water, planing, propulsor load).
 *
 * The wake is a change of the sea surface, not paint on it: every frame the hull's recorded track
 * (src/world/traffic/hullTrack.ts: position, heading, speed, planing and the propulsors' load) is
 * turned into a strip in track coordinates (src/world/water/wakeField.ts) and rendered into the
 * wake map (src/world/water/wakeMap.ts), a half-float texture following the boat — 520 m across
 * for boats, up to 2.6 km for ships: Kelvin diverging and transverse waves, the quarter waves and
 * rooster behind the transom, a ship's bow wave, the white-water trail and its streaks, aeration
 * and slick. The sea shader reads it (normals, vertex lift, per-pixel foam lace, turquoise bubble
 * water), so the wake's crests catch the sky and the sun like the rest of the water.
 *
 * Spray: soft droplet clusters in the traffic's point material, lit — sheets off the bow chines
 * when fast, droplets off the quarter waves when planing, the rooster tail thrown up behind the
 * transom (a tall narrow plume behind a jet drive), bursts when the bow slams into a wave, a big
 * ship's bow wave breaking — plus a faint mist; all fall back onto the water. One offscreen pass
 * (the map) and one point draw while a boat is driven; nothing when an aircraft is flown. The
 * 'low' quality preset halves the map's resolution and the spray. Resets on onReset /
 * onAircraftChange. `?waterGpu=1` also times the map pass (stats().mapGpuMs).
 *
 * Dev / QA: `?wakeHull=L,B[,jet]` draws the driven boat's wake as if its hull were L × B m (a
 * 265 m ship: `?wakeHull=265,32` — hulls over 60 m are drawn as displacement hulls; a jet ski:
 * `?wakeHull=3.3,1.2,jet`), to photograph the wake of vessels that aren't in the fleet yet.
 */
import * as THREE from 'three';
import { CONFIG, type WatercraftConfig } from '../../config';
import { createLightingUniforms, createPointMaterial } from '../../world/traffic/materials';
import { syncLighting } from '../../world/traffic/daylight';
import { PointBuffer } from '../../world/traffic/points';
import { bowSprayOrigin, hullSize, HullTrack, sprayRates, type HullSize } from '../../world/traffic/hullTrack';
import { mulberry32 } from '../../world/traffic/rng';
import { buildWakeStrip, newWakeStrip, wakeMapExtent, wakeMapFrame, wakeScale } from '../../world/water/wakeField';
import { createWakeMap } from '../../world/water/wakeMap';
import { qualityFromQuery } from '../../render/quality';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

/** How long the track is kept for a V50-sized map (s) — the far wake fades out by then; × the map's scale for ships. */
const MAX_AGE = 90;
/** Spray particle pool. */
const MAX_SPRAY = 3200;
/** Wake map resolution (texels per side; half on the low quality preset). */
const MAP_RES = 1024;
/** Track entries per second. */
const TRACK_DT = 0.1;

/** The propulsors' wash (0..1.3): the mean engine load of the drives that push water aft (not tunnel thrusters), 0 out of gear. */
export function propulsorWash(wc: WatercraftConfig, props: readonly { load: number; gear: string }[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < props.length; i++) {
    const cfg = wc.propulsors[i] as { type?: string } | undefined;
    if (cfg?.type === 'thruster') continue;
    const p = props[i];
    const l = p.gear === 'neutral' ? 0 : Math.abs(Number.isFinite(p.load) ? p.load : 0);
    sum += Math.min(1.3, l);
    n++;
  }
  return n ? sum / n : 0.7;
}

/** The vessel's watercraft config, or null for an aircraft. */
export function watercraftOf(def: AircraftDef | null | undefined): WatercraftConfig | null {
  if (!def) return null;
  const wc = (def.config.aircraft as { watercraft?: WatercraftConfig | null }).watercraft ?? null;
  return def.kind === 'vessel' || wc ? wc : null;
}

/** A GPU timer around one pass (EXT_disjoint_timer_query_webgl2), smoothed ms; null when unsupported. */
function gpuTimer(renderer: THREE.WebGLRenderer): { begin(): void; end(): void; ms(): number } | null {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  if (!ext) return null;
  const inFlight: WebGLQuery[] = [];
  const pool: WebGLQuery[] = [];
  let active: WebGLQuery | null = null;
  let ms = -1;
  return {
    begin() {
      while (inFlight.length && gl.getQueryParameter(inFlight[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = inFlight.shift()!;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          const v = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
          ms = ms < 0 ? v : ms + (v - ms) * 0.1;
        }
        pool.push(q);
      }
      if (inFlight.length > 4) return;
      active = pool.pop() ?? gl.createQuery();
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      inFlight.push(active);
      active = null;
    },
    ms: () => Math.round(ms * 1000) / 1000,
  };
}

const mod: SystemModule = {
  name: 'playerWake',
  // after the traffic (ships 44)
  order: 47,
  create(ctx) {
    let low = false;
    try {
      low = qualityFromQuery(typeof location !== 'undefined' ? location.search : '') === 'low';
    } catch {
      /* no location (tests) */
    }
    const mapRes = low ? MAP_RES / 2 : MAP_RES;
    let hullOverride: { L: number; B: number; jet: boolean } | null = null;
    try {
      const w = new URLSearchParams(location.search).get('wakeHull');
      if (w) {
        const [L, B, j] = w.split(',');
        if (Number(L) > 1 && Number(B) > 0.3) hullOverride = { L: Number(L), B: Number(B), jet: j === 'jet' };
      }
    } catch {
      /* no location (tests) */
    }
    const sprayGain = low ? 0.5 : 1;
    const shared = createLightingUniforms();
    const pointMat = createPointMaterial(shared);
    const wakeMap = createWakeMap({ res: mapRes, extent: 520 });
    const strip = newWakeStrip();
    const mapFrame = wakeMapFrame(0, 0, 0, 520, mapRes);

    const points = new PointBuffer(MAX_SPRAY);
    const pointsObj = new THREE.Points(points.geometry, pointMat);
    pointsObj.name = 'player.spray';
    pointsObj.frustumCulled = false;
    pointsObj.renderOrder = -1;
    pointsObj.visible = false;
    ctx.scene.add(pointsObj);

    let timer: ReturnType<typeof gpuTimer> = null;
    try {
      if (new URLSearchParams(location.search).get('waterGpu') === '1') timer = gpuTimer(ctx.renderer);
    } catch {
      /* no location (tests) */
    }

    let track = new HullTrack(Math.ceil(MAX_AGE / TRACK_DT) + 40, TRACK_DT);
    const rates = { bow: 0, quarter: 0, slam: 0 };
    const acc = { bow: 0, quarter: 0, slam: 0, mist: 0, rooster: 0, bowWave: 0 };
    const spray = {
      x: new Float32Array(MAX_SPRAY), y: new Float32Array(MAX_SPRAY), z: new Float32Array(MAX_SPRAY),
      vx: new Float32Array(MAX_SPRAY), vy: new Float32Array(MAX_SPRAY), vz: new Float32Array(MAX_SPRAY),
      age: new Float32Array(MAX_SPRAY).fill(1e9), life: new Float32Array(MAX_SPRAY).fill(1), size: new Float32Array(MAX_SPRAY),
      /** 0 droplet (hard, small), 1 mist (soft, large, faint). */
      kind: new Uint8Array(MAX_SPRAY),
      next: 0, live: 0,
    };
    const rand = mulberry32(0x5a1d);
    const q = new THREE.Quaternion();
    const v3 = new THREE.Vector3();
    const w3 = new THREE.Vector3();
    const o3 = { x: 0, y: 0, z: 0 };
    const cam = new THREE.Vector3();

    let wc: WatercraftConfig | null = null;
    let size: HullSize | null = null;
    /** The hull's map extent (m), its scale over the V50's 520 m map, its wake scale, a jet drive. */
    let extent = 520;
    let bandScale = 1;
    let sizeScale = 1;
    let jet = false;
    let active = false;
    let mapShown = false;

    const setCraft = (def: AircraftDef | null | undefined) => {
      wc = watercraftOf(def);
      size = wc ? hullSize(wc.hull.stations) : null;
      if (size && hullOverride) {
        size = { length: hullOverride.L, beam: hullOverride.B, midZ: size.midZ, stemZ: size.midZ - hullOverride.L / 2, transomZ: size.midZ + hullOverride.L / 2 };
      }
      extent = size ? wakeMapExtent(size.length) : 520;
      bandScale = extent / 520;
      sizeScale = size ? wakeScale(size.length, size.beam) : 1;
      jet = hullOverride ? hullOverride.jet : !!wc?.propulsors.some((p) => (p as { type?: string }).type === 'jet');
      const cap = Math.ceil((MAX_AGE * bandScale) / TRACK_DT) + 40;
      if (cap !== track.capacity) track = new HullTrack(cap, TRACK_DT);
    };
    setCraft(ctx.actions?.currentAircraft?.());
    const clear = () => {
      track.reset();
      spray.age.fill(1e9);
      spray.live = 0;
      acc.bow = acc.quarter = acc.slam = acc.mist = acc.rooster = acc.bowWave = 0;
      pointsObj.visible = false;
      points.reset();
      points.commit();
      wakeMap.hide();
      mapShown = false;
    };

    const emit = (kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, sz: number) => {
      const i = spray.next;
      spray.next = (spray.next + 1) % MAX_SPRAY;
      spray.x[i] = x;
      spray.y[i] = y;
      spray.z[i] = z;
      spray.vx[i] = vx;
      spray.vy[i] = vy;
      spray.vz[i] = vz;
      spray.age[i] = 0;
      spray.life[i] = life;
      spray.size[i] = sz;
      spray.kind[i] = kind;
    };

    return {
      update(f) {
        if (f.def && watercraftOf(f.def) !== wc) setCraft(f.def);
        const vs = f.state.vessel;
        if (!wc || !size || !vs) {
          if (active) {
            clear();
            active = false;
          }
          return;
        }
        active = true;
        const s = f.state;
        const dt = f.paused ? 0 : Math.max(0, Math.min(0.1, Number.isFinite(f.dt) ? f.dt : 0));
        const atmo = ctx.atmosphere;
        syncLighting(shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
        f.camera.getWorldPosition(cam);
        shared.uTime.value = f.waveTime;
        pointMat.uniforms.uHalfHeight.value = (ctx.renderer.domElement.height || 900) / 2;

        // ── the hull's track ──
        q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w);
        v3.set(0, 0, -1).applyQuaternion(q);
        const heading = ((Math.atan2(v3.x, -v3.z) * 180) / Math.PI + 360) % 360;
        w3.set(0, 0, size.midZ).applyQuaternion(q);
        const hx = s.position.x + w3.x;
        const hz = s.position.z + w3.z;
        const speed = Math.abs(vs.speedMs);
        const wash = propulsorWash(wc, vs.propulsors);
        const planing = hullOverride && hullOverride.L > 60 ? 0 : vs.planing;
        track.push(s.time, hx, hz, heading, speed, planing, wash);
        const level = ctx.env.waterLevel(hx, hz);
        const far = Math.hypot(cam.x - hx, cam.z - hz) > CONFIG.world.traffic.sea.wakeDistance || cam.y - (level ?? 0) > 4000;

        // ── the wake map (the sea reads it) ──
        if (!far && level !== null && Math.abs(level) < 0.5 && track.length > 1) {
          buildWakeStrip(track, s.time, size.length, size.beam, strip, bandScale);
          wakeMapFrame(hx, hz, heading, extent, mapRes, 0.3, mapFrame);
          timer?.begin();
          wakeMap.render(ctx.renderer, strip, mapFrame, track.travelled, size.length, size.beam);
          timer?.end();
          mapShown = strip.count > 1;
        } else if (mapShown) {
          wakeMap.hide();
          mapShown = false;
        }

        // ── spray ──
        const V = s.velocity;
        if (dt > 0 && !far && level !== null && !s.crash) {
          // how fast the bow is falling onto the water (pitching into a wave)
          const av = s.angularVelocity;
          const bz = size.stemZ * 0.8;
          w3.set(av.y * bz, -av.x * bz, 0).applyQuaternion(q);
          const bowVy = V.y + w3.y;
          v3.set(0, 0, bz).applyQuaternion(q);
          const bowY = s.position.y + v3.y;
          const impact = bowY - vs.surfaceY < 0.6 ? Math.max(0, -bowVy) : 0;
          sprayRates(speed, vs.planing, impact, rates);
          const fx = Math.sin((heading * Math.PI) / 180);
          const fz = -Math.cos((heading * Math.PI) / 180);
          const sp = Math.min(1, speed / 14);
          // droplet clusters grow with the hull (a ship's spray is heavier), their number less so
          const pz = Math.min(3, Math.max(0.6, Math.sqrt(sizeScale)));
          const rz = 1.7 * sprayGain * Math.min(1.6, Math.max(0.5, Math.sqrt(sizeScale)));
          rates.bow *= rz;
          rates.quarter *= rz;
          rates.slam *= rz;
          // bow sheets: many small droplets fanned out from the chine's spray root
          acc.bow += rates.bow * 6 * dt;
          while (acc.bow >= 1) {
            acc.bow -= 1;
            const side = rand() < 0.5 ? -1 : 1;
            bowSprayOrigin(size, vs.planing, side, o3);
            const along = (rand() - 0.5) * 0.12 * size.length;
            v3.set(o3.x, 0, o3.z + along).applyQuaternion(q);
            const out = (2.5 + 4.5 * rand()) * (0.5 + 0.5 * sp);
            // a low sheet along the chine (it rarely climbs past the rubbing strake)
            const up = (0.8 + 2.2 * rand() * rand()) * (0.5 + 0.6 * sp);
            emit(0, s.position.x + v3.x, vs.surfaceY + 0.1, s.position.z + v3.z, V.x * 0.6 - fz * out * side, up, V.z * 0.6 + fx * out * side, 0.3 + 0.45 * rand(), (0.1 + 0.16 * rand()) * pz);
          }
          // droplets thrown off the quarter waves behind the transom
          acc.quarter += rates.quarter * 1.5 * dt;
          while (acc.quarter >= 1) {
            acc.quarter -= 1;
            const side = rand() < 0.5 ? -1 : 1;
            v3.set(side * size.beam * (0.35 + 0.25 * rand()), 0, size.transomZ + 0.5 + 2.5 * rand()).applyQuaternion(q);
            emit(0, s.position.x + v3.x, vs.surfaceY + 0.15, s.position.z + v3.z, V.x * 0.8 + (rand() - 0.5) * 1.5 - fz * side * 0.8, 0.6 + 1.6 * rand(), V.z * 0.8 + (rand() - 0.5) * 1.5 + fx * side * 0.8, 0.3 + 0.5 * rand(), (0.12 + 0.18 * rand()) * pz);
          }
          // the rooster tail: where the flows off both chines meet behind a planing transom the water
          // is thrown up in a plume that hangs at a fixed distance behind the boat and falls back —
          // right at the transom and tall and narrow behind a jet drive (a jet ski's plume)
          const pr = Math.min(1, Math.max(0, vs.planing)) * Math.min(1, Math.max(0, (speed - 5) / 7)) * Math.min(1.2, wash + 0.2);
          acc.rooster += pr * (jet ? 150 : 70) * sprayGain * dt;
          while (acc.rooster >= 1) {
            acc.rooster -= 1;
            const back = jet ? 0.3 + 0.6 * rand() : size.length * (0.25 + 0.5 * rand());
            const lat = (rand() - 0.5) * size.beam * (jet ? 0.12 : 0.35);
            v3.set(lat, 0, size.transomZ + back).applyQuaternion(q);
            const upv = (jet ? 3.5 + 3.5 * rand() : 1.6 + 2.6 * rand() * rand()) * (0.6 + 0.5 * sp) * Math.sqrt(pz);
            // the plume's water moves on with the boat at a fraction of its speed (it trails behind)
            const keep = jet ? 0.7 + 0.15 * rand() : 0.5 + 0.3 * rand();
            emit(0, s.position.x + v3.x, vs.surfaceY + 0.05, s.position.z + v3.z, V.x * keep + (rand() - 0.5) * 0.9, upv, V.z * keep + (rand() - 0.5) * 0.9, 0.5 + 0.7 * rand(), (jet ? 0.09 + 0.12 * rand() : 0.12 + 0.2 * rand()) * pz);
          }
          // a big displacement hull's bow wave breaking along the stem: heavy, low clumps of white water
          const frB = speed / Math.sqrt(9.81 * size.length);
          const pb = (1 - Math.min(1, Math.max(0, vs.planing))) * Math.min(1, Math.max(0, (frB - 0.12) / 0.12)) * Math.min(1, Math.max(0, (sizeScale - 1.5) / 3));
          acc.bowWave += pb * 90 * sprayGain * dt;
          while (acc.bowWave >= 1) {
            acc.bowWave -= 1;
            const side = rand() < 0.5 ? -1 : 1;
            const along = size.length * (0.01 + 0.08 * rand());
            v3.set(side * (0.15 + 0.35 * Math.sqrt(along / (0.15 * size.length))) * size.beam * 0.5 * 1.1, 0, size.stemZ + along).applyQuaternion(q);
            const out = (1 + 2.5 * rand()) * pz * 0.5;
            emit(0, s.position.x + v3.x, vs.surfaceY + 0.3 * pz, s.position.z + v3.z, V.x * 0.85 - fz * out * side, (0.8 + 2.2 * rand()) * Math.sqrt(pz), V.z * 0.85 + fx * out * side, 0.6 + 0.8 * rand(), (0.3 + 0.4 * rand()) * pz);
          }
          // a bow slamming into a wave: a burst of heavier spray
          acc.slam += rates.slam * 4 * dt;
          while (acc.slam >= 1) {
            acc.slam -= 1;
            const side = rand() < 0.5 ? -1 : 1;
            v3.set(side * size.beam * 0.45 * rand(), 0, size.stemZ + size.length * (0.1 + 0.2 * rand())).applyQuaternion(q);
            const out = 3 + 6 * rand();
            emit(0, s.position.x + v3.x, vs.surfaceY + 0.2, s.position.z + v3.z, V.x * 0.55 - fz * out * side, 2.5 + 6 * rand(), V.z * 0.55 + fx * out * side, 0.6 + 0.9 * rand(), (0.14 + 0.22 * rand()) * pz);
          }
          // a faint mist drifting off the bow sheets
          acc.mist += (rates.bow * 0.12 + rates.slam * 0.1 + pr * (jet ? 14 : 6) * sprayGain) * dt;
          while (acc.mist >= 1) {
            acc.mist -= 1;
            const side = rand() < 0.5 ? -1 : 1;
            bowSprayOrigin(size, vs.planing, side, o3);
            v3.set(o3.x * 1.4, 0, o3.z + 2 * rand()).applyQuaternion(q);
            emit(1, s.position.x + v3.x, vs.surfaceY + 0.6, s.position.z + v3.z, V.x * 0.35 - fz * side * 1.5, 0.6 + 0.6 * rand(), V.z * 0.35 + fx * side * 1.5, 1 + 1.2 * rand(), (0.6 + 0.8 * rand()) * pz);
          }
        }
        // step and draw the particles
        points.reset();
        let live = 0;
        for (let i = 0; i < MAX_SPRAY; i++) {
          if (spray.age[i] >= spray.life[i]) continue;
          const mist = spray.kind[i] === 1;
          if (dt > 0) {
            spray.age[i] += dt;
            spray.vy[i] -= (mist ? 1.5 : 9.81) * dt;
            const k = Math.exp(-(mist ? 1.6 : 0.5) * dt);
            spray.vx[i] *= k;
            spray.vz[i] *= k;
            spray.x[i] += spray.vx[i] * dt;
            spray.y[i] += spray.vy[i] * dt;
            spray.z[i] += spray.vz[i] * dt;
            // droplets that fall back into the sea are gone
            if (!mist && spray.y[i] < vs.surfaceY - 0.3) spray.age[i] = spray.life[i];
          }
          const a = spray.age[i] / spray.life[i];
          if (a >= 1) continue;
          live++;
          if (mist) {
            const alpha = 0.045 * (1 - a) * Math.min(1, a * 5);
            points.push(spray.x[i], spray.y[i], spray.z[i], 0.92, 0.95, 0.97, alpha, spray.size[i] * (1 + 1.8 * a), 1.5, 1);
          } else {
            // soft, translucent droplet clusters (a hard 1-px dot reads as confetti at any distance, a
            // big disc as a ball): many small faint ones that spread as they fly make a hazy sheet
            const alpha = 0.34 * (1 - a * a) * Math.min(1, a * 12);
            points.push(spray.x[i], spray.y[i], spray.z[i], 0.93, 0.96, 0.98, alpha, spray.size[i] * 0.62 * (1 + 1.2 * a), 1.6, 1);
          }
        }
        spray.live = live;
        points.commit();
        pointsObj.visible = points.count > 0;
      },
      onReset() {
        clear();
      },
      onAircraftChange(def) {
        setCraft(def);
        clear();
      },
      stats: () => ({
        active,
        map: mapShown,
        strip: strip.count,
        spray: spray.live,
        track: track.length,
        trackSpan: Math.round(track.span * 10) / 10,
        travelled: Math.round(track.travelled),
        mapGpuMs: timer ? timer.ms() : null,
        mapExtent: extent,
        mapRes,
        drawCalls: (mapShown ? 1 : 0) + (pointsObj.visible ? 1 : 0),
      }),
      dispose() {
        wakeMap.dispose();
        points.dispose();
        pointMat.dispose();
        pointsObj.removeFromParent();
      },
    };
  },
};
export default mod;
