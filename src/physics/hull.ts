/**
 * Boats and ships (PURE, deterministic): the hull, its engines and propulsors, for any vessel whose
 * config sets `watercraft` — step() in ./aircraft.ts hands such a config to stepVessel() the way it
 * hands a helicopter to ./rotor.ts. One model for every size, from a sports yacht to a battleship:
 * everything below scales from the station table and a handful of coefficients.
 *
 * ─── The model ────────────────────────────────────────────────────────────────────────────────
 * Hydrostatics. The hull (config `hull.stations`, the same table the 3D model lofts) is resampled
 *   into a grid of vertical columns. Each column is a prism from the hull bottom to the deck edge;
 *   the part below the local water surface displaces water: ρ g V, applied at the centroid of the
 *   wet part. The surface is the SAME Gerstner sea the renderer draws (src/world/water/waves.ts,
 *   with the shader's shoaling in shallow water), sampled on a coarse grid over the hull at the
 *   vessel's wave clock (`vessel.seaTime`) and interpolated per column — so heave, pitch, roll,
 *   the righting moment and riding the waves all come from the shape, not from tuned springs.
 * Vertical damping. Each wet column feels linear (radiation) + quadratic (viscous) damping on its
 *   vertical speed relative to the moving surface (the waves' orbital heave), plus extra roll damping.
 * Planing lift (Savitsky 1964, dynamic term). C_L0 = τ^1.1 · 0.012 λ^½ (τ trim in degrees, λ mean
 *   wetted length / beam from the wet columns), corrected for deadrise β: C_Lβ = C_L0 − 0.0065 β
 *   C_L0^0.6; L = ½ ρ V² B² C_Lβ, acting normal to the bottom at Savitsky's centre of pressure. The
 *   hydrostatic half of Savitsky's lift is the column buoyancy itself. Because the lift is normal to
 *   the keel, its aft tilt is the pressure drag Δ tan τ, and the hull rising out of the water shrinks
 *   the wetted area — the planing transition emerges.
 * Resistance. ITTC-57 friction on the live wetted surface, × form factor; residuary (wave-making)
 *   resistance from a Cr(Fn) table on the static wetted surface (Holtrop-style shape: rising to the
 *   hump, falling as the hull planes); windage on the superstructure.
 * The hull's own wave. A Kelvin transverse wave (λ = 2πU²/g, crest at the bow, less its mean over
 *   the waterline: it moves the pressure, it adds no displacement) is added to the surface the columns float in: near Fn 0.5 its trough lies under the stern, which settles while
 *   the bow rises — the hump trim of a planing hull and the sinkage and trim of a ship at speed.
 * Manoeuvring. Clarke's (1982) linear derivatives Y_v, Y_r, N_v, N_r from the live wetted length,
 *   draft, beam and block coefficient (the regression Fossen recommends), plus strip cross-flow drag
 *   (nonlinear sway / yaw damping), plus added mass per axis scaled by the immersion.
 * Propulsion. Each propulsor has its own marine diesel (governor, torque rise, turbo lag) driving a
 *   propeller with linear open-water curves KT(J), KQ(J); the shaft speed comes from the torque
 *   balance, so the engines lug at the hump and in a crash stop. Pods (Volvo IPS, azipods) turn the
 *   whole thrust line; shaft drives have a rudder in the propeller's slipstream. Either way the leg /
 *   rudder is also a foil with lift and stall. Trim tabs add stern lift (bow down).
 * Contacts. Points round the hull (keel, chines, deck edge, pods) are held out of the sea bed, the
 *   shore (env.groundHeight) and structures (env.obstacleTop: marina pontoons, quays) by spring-
 *   dampers with friction; hitting hard holes the hull (crash). Lying on the beam too long capsizes.
 * Mooring. At the berth, lines hold the boat until the lever first goes into gear.
 *
 * Frames and signs follow src/types.ts: body +X starboard, +Y up, −Z bow; steerDeg + turns the bow
 * to starboard. Controls: throttle = the helm lever (−1 full astern … +1 full ahead, neutral inside
 * ±neutralDetent), rudder + aileron = the helm, elevatorTrim < 0 = trim tabs down, engineOn = E.
 *
 * ─── Calibration: Princess V50 (14.2 t half load, 2 × Volvo Penta IPS 600 / D6-435; calm sea) ───
 * Checked by tests/physics/v50.test.ts and v50-fuzz.test.ts.
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Displacement / waterline length / draft   14.2 t (13.85 m³) / 13.2 m / 0.63 m hull, 1.03 m to the drives   14.2 t / — / 1.14 m
 *   Static trim, calm                          −0.07° (level)                        level
 *   Full ahead from rest: hump trim            ~6° bow up at 12–16 kt                5–7°
 *   …on the plane (> 50 % dynamic lift)        ~12 s; 25 kt in ~17 s; 30 kt in ~30 s  "on the plane in seconds"
 *   Top speed, full ahead                      34.4 kt at 3,500 rpm (rated), trim 3.7°, 87 % dynamic lift   34 kt, 3,500 rpm
 *   Cruise 30 kt                               lever ~0.9, trim ~4°                  32 kt cruise
 *   Slow ahead, lever 0.2                      ~7.5 kt at ~1,070 rpm                 6–8 kt at ~1,000 rpm
 *   Full astern from rest                      ~12 kt astern                         —
 *   Crash stop from 30 kt (full astern)        stopped in ~12 s                      —
 *   Hard over at 30 kt                         banks 9° INTO the turn, ~12 °/s, circle ~120 m, 30 → 25 kt   banks in, no capsize
 *   Hard over at 6 kt (drives 22°)             circle ~65 m, heels 1.4° outward       3–5 lengths
 *   Rights from a 30° heel                     < 3° within 25 s                      positive stability
 *   Default sea (12 kt wind), full ahead       rides it at ~33 kt, pitching a few degrees with the waves
 *   Grounding: dead slow onto a 1 : 10 beach   aground, no damage, backs off astern; at > 17 kt: holed
 *   Pontoon: at 2 kt held off it; at 20 kt     holed
 *   step() cost (node)                         ~35 µs (28 × 12 buoyancy columns, 15 wave samples, 47 contacts)
 *
 * ─── Calibration: USS Iowa (BB-61) (1980s full load 58,400 t; 4 shafts, 212,000 shp; calm sea) ───
 * Checked by tests/physics/iowa.test.ts and iowa-fuzz.test.ts (config: makeIowa() in src/config.ts).
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Displacement / LWL / draft (keel)          58,400 t (56,976 m³) / 262.0 m / 11.27 m   58,400 t / 262.13 m / 11.33 m
 *   Block coefficient (on 262.1 × 32.97 × 11.33)  0.585                              ~0.59
 *   Static trim, calm                          0.00°                                 level
 *   Roll period / GM (from the period)         16.7 s / 2.82 m                       — / 2.82 m (9.26 ft)
 *   Rights from a 30° heel                     < 3° within 150 s                     positive stability
 *   Default sea (12 kt wind), stopped          pitch σ < 0.5°, roll σ < 1.5°         steady platform
 *   Full ahead (lever 1)                       32.5 kt, 4,900 turbine rpm (202 shaft rpm), load 0.97–1.0, trim −0.09°   33 kt (normal load), ~202 rpm
 *   Full ahead from rest                       10 kt in 49 s, 20 kt in 96 s, 30 kt in 179 s   —
 *   Slow ahead, lever 0.2                      9.3 kt at 1,240 turbine rpm (51 shaft rpm)     5–10 kt
 *   Full astern from rest                      16.4 kt astern                        (astern turbines ~¼ power)
 *   Crash stop from 30 kt (full astern)        stopped in 241 s, head reach 1.53 km  "kilometres"
 *   Hard over at 30 kt (35°)                   tactical diameter 811 m, advance 770 m, heels 4.9° outward, 30 → 19 kt   744 m (814 yd)
 *   Hard over at 20 kt                         tactical diameter 810 m, heels 2.5° outward   695 m (760 yd)
 *   Grounding: dead slow onto a 1 : 20 bank    aground, no damage, backs off astern; at 20 kt: holed
 *   Pier: at ~4 kt held off it; at 10 kt       holed
 *   step() cost (node)                         ~160 µs (64 × 16 buoyancy columns, 27 wave samples, 177 contacts)
 * Notes: one MarineEngineConfig per shaft stands for its turbine set (engine rpm = nominal HP-turbine
 * rpm through a 24.3 : 1 gear); the two inboard shafts carry the rudders (31.6 m² each), the outboard
 * shafts only a small strut foil; the turning circle comes out ~9 % wider than published (the rudder
 * area is the real 340 ft², the rest is the generic Clarke / cross-flow hull, tuned to crossFlowCd 0.1,
 * clarkeScale 1.3). createVesselState() trims its lever on the surge acceleration with the shafts
 * held at the lever's rpm, so a 22 kt start holds 22 kt (lever ~0.58); the Iowa tests still set their
 * levers from the propeller law.
 * ─── Calibration: MS Tater Star (Fantasy-class cruise ship, 40,000 t, 2 × 14 MW shafts + rudders, 6 tunnel thrusters; calm sea) ───
 * Checked by tests/physics/cruise.test.ts and cruise-fuzz.test.ts. Published: Carnival Fantasy class (see makeCruise()).
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Displacement / waterline length / draft   40,000 t (39,024 m³) / 235 m / 7.86 m  (est.) / ~225 m / 7.75–7.80 m
 *   Static trim, calm                          −0.06° (level)                        level
 *   Roll period (GM ≈ 1.8 m)                   20.9 s; from 20° the first swing back to −6.9°   ~20 s
 *   Full ahead: top speed                      22.5 kt at 600 rpm (rated), load 0.99  22.3 kt (trials), 21 kt service
 *   …gathering way from rest                   10 kt in ~2 min, 20 kt in ~5.4 min    —
 *   Service 21 kt                              lever 0.85, 527 rpm                   21 kt
 *   Slow ahead, lever 0.2 / dead slow          8.9 kt at 226 rpm / 6.8 kt             harbour speeds
 *   Full astern from rest                      ~13 kt astern                         —
 *   Crash stop from 21 kt (full astern)        stopped in ~5.5 min, track reach ~5.8 L (1.5 km)   IMO ≤ 15 L
 *   Hard over at 21 kt (35°)                   90° in ~113 s, steady circle ~4.0 L (1,030 m), heels 7° outward, 21 → 10.5 kt   ~3–4 L, heels out
 *   Hard over at 6 kt                          circle ~1.75 L (the propeller race on the rudders)
 *   Tunnel thrusters at 0 kt (← / →)          90° in ~94 s, ~1.1 °/s steady, drifts ~40 m in 5 min   turns on the spot
 *   …at 15 kt                                  nothing (faded out by 5 kt)            useless above ~5 kt
 *   Default sea (12 kt wind), 21 kt            pitch / roll < 1°                     a 260 m ship shrugs it off
 *   Grounding at 15 kt / a quay at 8 kt        holed (crashSpeedMs 1 m/s)            —
 *   step() cost (node)                         ~105 µs (52 × 16 buoyancy columns, 27 wave samples, 205 contacts)
 *
 * Tunnel thrusters (propulsor type 'thruster'): athwartships thrust at the tunnel, driven by the
 * aileron axis (+ = bow to starboard: bow units push to starboard, stern units to port), faded by
 * thrusterEffect(speed) and slewed at their electric rate; off with the engines. On a vessel that
 * has any, the rudder axis alone steers the rudders / pods (without, rudder + aileron as before).
 *
 * ─── Sea-Doo work: waterjets ('jet' propulsors, stepJet), strip planing, the rider, righting ─────
 * A waterjet is an axial pump on the crankshaft: flow Q = k (n − n_slip) (× the intake's immersion and
 * a cavitation factor: suction head 10.3 m + Va²/2g against an NPSH ∝ n²), Vj = Q / A_nozzle; the pump
 * absorbs ½ ρ Q (Vj² − Va²) / η, so the engine's torque balance sets the rpm (power-limited, no KT/KQ);
 * the gross thrust ρ Q Vj acts along the steered, trimmed (VTS) nozzle — or is turned forward and down
 * by the iBR bucket — and the inlet swallows the water's momentum (ρ Q Va, and sideways when skidding).
 * No flow, no steering: at idle only the off-throttle assist (OTAS: the ECU holds ~5,000 rpm when the
 * throttle is released at speed with the bars over) steers; the GPS limiter holds 58 kt; sucking air
 * off a crest the ECU cuts to ~4,200 rpm. A short, light, fast hull (hull.planingModel 'strips') gets
 * strip-theory planing (Zarnick added-mass momentum + cross-flow drag per strip and panel, Garme's
 * transom fade), radiation damping of heave, a little planing yaw damping, V-panel side forces acting
 * high, and a transom that leads going astern. The rider leans (a moment of their weight, balancing
 * like a skier toward the coordinated bank plus the carve asked for), is thrown off by a hard nose-in,
 * and after a capsize swims round and rolls the craft upright (config `righting`) — no wreck.
 *
 * ─── Calibration: Sea-Doo RXP-X 325 (490 kg with rider, Rotax 1630 ACE 242 kW, calm sea) ─────────
 * Checked by tests/physics/seadoo.test.ts and seadoo-fuzz.test.ts.
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Displacement / waterline length / draft   0.478 m³ / 2.88 m / 0.28 m (keel 0.31 m under)   490 kg loaded
 *   Static trim                                +0.5° (stern a touch down)            level-ish
 *   Full throttle from rest: on the plane      0.8 s (bow up 10° at ~12 kt)          "planes almost instantly"
 *   0–30 mph / 0–60 mph                        2.3 s / 3.5 s (the pump cavitates off the line)   — / 3.4 s (maker; 4.6 s measured 3–62 mph)
 *   Top speed (GPS limiter)                    57.7 kt at ~6,400 rpm, trim ~0.4°, mild porpoising   ~58 kt (67 mph) governed
 *   …limiter off                               74 kt at the 8,000 rpm limiter        (the power is there)
 *   Lever 0.3 / 0.5 / 0.7                      16 / 35 / 52 kt at 3,300 / 4,650 / 6,000 rpm
 *   Full reverse (iBR)                         5.3 kt astern                          ~5 mph
 *   iBR brake from 40 kt                       stopped (< 2 kt) in 35 m, 3.8 s        "30 % shorter" than coasting
 *   Full helm (← : full lean) at 16 / 21 / 26 / 39 kt   circle ~70 / ~115 / ~160 / ~275 m, banked 12–14° into the turn   much tighter on the real ski
 *   Full throttle + full helm from rest        a banked, accelerating carve to 58 kt; no capsize
 *   Idle in neutral, bars over                 < 15° of turn in 6 s (the idle creep)   no steering at idle
 *   Capsized (170° heel), nearly stopped       rolled upright over 3.0 s, rider back on at 4.5 s, engine restarts
 *   Flat landing from 1.5 m at 45 kt           lands and runs on, rider aboard; nose-in at 50 kt: a spill
 *   Beach at ~4 kt / at 45 kt                  beached, no damage / holed
 *   Idling (lever 0.15) out of the marina      casts off and idles out through the default sea (fleet test)
 *   step() cost (node)                         ~40–60 µs (20 × 10 columns, 6 wave samples, 34 contacts)
 */
import { CONFIG, MS_TO_KT, type Config, type HullStation, type PropulsorConfig, type WatercraftConfig } from '../config';
import type { AircraftState, Controls, DerivedData, EngineState, Environment, MarineGear, PropulsorState, Quat, RiderState, Vec3, VesselState } from '../types';
import { clamp, moveToward, smoothstep, wrap180 } from '../math/vec3';
import { qIntegrateBody, qSlerp } from '../math/quat';
import { bodyToWorld, eulerFromQuat, pqrFromOmega, quatFromEuler, worldToBody } from './frames';
import { airDensity } from './atmosphere';
import { getSeaSpectrum, type WaveSpectrum } from '../world/water/waves';

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
/** Kinematic viscosity of sea water at 15 °C, m²/s. */
const NU_WATER = 1.19e-6;
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

// ─── Hull geometry (precomputed once per config) ───────────────────────────────────────────────

/** A station interpolated at body z (linear between the table's stations; clamped at the ends). */
export function stationAt(stations: readonly HullStation[], z: number): HullStation {
  const n = stations.length;
  if (z <= stations[0].z) return { ...stations[0], z };
  if (z >= stations[n - 1].z) return { ...stations[n - 1], z };
  let i = 0;
  while (i < n - 2 && stations[i + 1].z < z) i++;
  const a = stations[i];
  const b = stations[i + 1];
  const t = (z - a.z) / Math.max(1e-9, b.z - a.z);
  const l = (p: number, q: number) => p + (q - p) * t;
  return { z, keelY: l(a.keelY, b.keelY), chineHalf: l(a.chineHalf, b.chineHalf), chineY: l(a.chineY, b.chineY), deckHalf: l(a.deckHalf, b.deckHalf), deckY: l(a.deckY, b.deckY) };
}

/** Height of the hull surface (body y) at half-breadth |x| of a station: the V bottom, then the topsides. */
export function hullBottomY(s: HullStation, x: number): number {
  const ax = Math.abs(x);
  if (ax <= s.chineHalf && s.chineHalf > 1e-6) return s.keelY + ((s.chineY - s.keelY) * ax) / s.chineHalf;
  if (s.deckHalf - s.chineHalf < 1e-6) return s.chineY;
  return s.chineY + ((s.deckY - s.chineY) * (ax - s.chineHalf)) / (s.deckHalf - s.chineHalf);
}

interface Column {
  /** Body position of the column's bottom (x, y, z) and its top (deck) height. */
  x: number;
  y: number;
  z: number;
  top: number;
  /** Plan area (m²) and wetted-surface area of its bottom panel (m², plan × slope factor). */
  area: number;
  surface: number;
  /** On the bottom (inside the chine): a planing surface. */
  bottom: boolean;
  /** Index of its long strip, and 0 = the strip's centreline-most column. */
  strip: number;
  centre: boolean;
  /** The column nearest the chine (for the chine wetted length). */
  chine: boolean;
  /** Buttock slope at the column, rad (+ = the bottom rising toward the bow: the forefoot's rocker). */
  rocker: number;
}

interface HullGeom {
  cols: Column[];
  strips: number;
  stripZ: number[];
  dz: number;
  zBow: number;
  zStern: number;
  /** Chine beam (planing beam B) and the largest beam. */
  chineBeam: number;
  maxBeam: number;
  /** Deadrise at the transom, deg. */
  deadriseDeg: number;
  /** Keel-line slope aft (rad, + = keel rising toward the stern: the bottom sits bow-down in the body frame). */
  keelSlope: number;
  /** Forward end of the static waterline (body z): where the hull's own bow wave crest stands. */
  zWlBow: number;
  /** Static waterline (body y) at rest, level; displaced volume ∇ (m³); waterline length, beam, draft, block coefficient, wetted surface. */
  waterlineY: number;
  volume: number;
  lwl: number;
  bwl: number;
  draft: number;
  cb: number;
  s0: number;
  /** Contact points (body) round the hull, and the index where the deck-edge points start. */
  contacts: Vec3[];
  /** Wave sample positions (body x, z). */
  waveX: number[];
  waveZ: number[];
}

const geomCache = new WeakMap<WatercraftConfig, Map<number, HullGeom>>();

/** The hull's column grid, contacts, static waterline and form coefficients (cached per config and mass). */
export function hullGeometry(wc: WatercraftConfig, mass: number): HullGeom {
  let byMass = geomCache.get(wc);
  if (!byMass) {
    byMass = new Map();
    geomCache.set(wc, byMass);
  }
  const hit = byMass.get(mass);
  if (hit) return hit;
  const h = wc.hull;
  const st = h.stations;
  const zBow = st[0].z;
  const zStern = st[st.length - 1].z;
  const strips = Math.max(4, Math.round(h.gridLong));
  const nt = Math.max(2, Math.round(h.gridTrans));
  const dz = (zStern - zBow) / strips;
  const cols: Column[] = [];
  const stripZ: number[] = [];
  let chineBeam = 0;
  let maxBeam = 0;
  for (const s of st) {
    chineBeam = Math.max(chineBeam, 2 * s.chineHalf);
    maxBeam = Math.max(maxBeam, 2 * s.deckHalf);
  }
  for (let i = 0; i < strips; i++) {
    const z = zBow + (i + 0.5) * dz;
    stripZ.push(z);
    const s = stationAt(st, z);
    const half = s.deckHalf;
    const dx = half / nt;
    // the column nearest the chine (still on the bottom)
    let chineJ = 0;
    for (let j = 0; j < nt; j++) if ((j + 0.5) * dx <= s.chineHalf) chineJ = j;
    for (let j = 0; j < nt; j++) {
      const x = (j + 0.5) * dx;
      const y = hullBottomY(s, x);
      const slope = (hullBottomY(s, x + 0.5 * dx) - hullBottomY(s, Math.max(0, x - 0.5 * dx))) / dx;
      const area = dx * dz;
      const surface = area * Math.sqrt(1 + slope * slope);
      const bottom = x <= s.chineHalf;
      const e = 0.25 * dz;
      const rocker = Math.atan2(hullBottomY(stationAt(st, z - e), x) - hullBottomY(stationAt(st, z + e), x), 2 * e);
      for (const side of [-1, 1]) {
        cols.push({ x: side * x, y, z, top: Math.max(s.deckY, y + 0.05), area, surface, bottom, strip: i, centre: j === 0, chine: j === chineJ, rocker });
      }
    }
  }
  const tr = st[st.length - 1];
  const deadriseDeg = tr.chineHalf > 1e-6 ? Math.atan2(tr.chineY - tr.keelY, tr.chineHalf) / DEG : 0;
  // keel slope over the aft 60 % (the planing surface)
  const zA = zBow + 0.4 * (zStern - zBow);
  const keelSlope = Math.atan2(stationAt(st, zStern).keelY - stationAt(st, zA).keelY, zStern - zA);

  // Static waterline: level hull, displaced volume = m / ρ (bisection).
  const vol = mass / wc.waterDensity;
  const volumeAt = (wl: number) => {
    let v = 0;
    for (const c of cols) v += c.area * clamp(wl - c.y, 0, c.top - c.y);
    return v;
  };
  let lo = Math.min(...cols.map((c) => c.y));
  let hi = Math.max(...cols.map((c) => c.top));
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (volumeAt(mid) > vol) hi = mid;
    else lo = mid;
  }
  const waterlineY = 0.5 * (lo + hi);
  let zF = Infinity;
  let zA2 = -Infinity;
  let bwl = 0;
  let s0 = 0;
  let keelMin = Infinity;
  for (const c of cols) {
    if (c.y < waterlineY) {
      zF = Math.min(zF, c.z - dz / 2);
      zA2 = Math.max(zA2, c.z + dz / 2);
      bwl = Math.max(bwl, 2 * Math.abs(c.x) + (2 * stationAt(st, c.z).deckHalf) / nt);
      s0 += c.surface;
    }
    keelMin = Math.min(keelMin, c.y);
  }
  const lwl = Math.max(0.5, zA2 - zF);
  const draft = Math.max(0.05, waterlineY - keelMin);
  const cb = clamp(vol / (lwl * bwl * draft), 0.2, 0.95);

  // Contacts: keel, chines and deck edges at every station (and midway), the stem head, the pods.
  const contacts: Vec3[] = [];
  const zs: number[] = [];
  for (let i = 0; i < st.length; i++) {
    zs.push(st[i].z);
    if (i + 1 < st.length) zs.push(0.5 * (st[i].z + st[i + 1].z));
  }
  for (const z of zs) {
    const s = stationAt(st, z);
    contacts.push({ x: 0, y: s.keelY, z });
    if (s.chineHalf > 0.05) {
      contacts.push({ x: -s.chineHalf, y: s.chineY, z });
      contacts.push({ x: s.chineHalf, y: s.chineY, z });
    }
  }
  for (const z of zs) {
    const s = stationAt(st, z);
    if (s.deckHalf > 0.05) {
      contacts.push({ x: -s.deckHalf, y: s.deckY, z });
      contacts.push({ x: s.deckHalf, y: s.deckY, z });
    } else contacts.push({ x: 0, y: s.deckY, z });
  }
  for (const p of wc.propulsors) if (p.type !== 'thruster') contacts.push({ x: p.position.x, y: p.position.y - p.diameter / 2, z: p.position.z });

  const nl = Math.max(2, Math.round(h.waveSamplesLong));
  const ntw = Math.max(1, Math.round(h.waveSamplesTrans));
  const waveX: number[] = [];
  const waveZ: number[] = [];
  for (let i = 0; i < nl; i++) waveZ.push(zBow + ((zStern - zBow) * i) / (nl - 1));
  for (let j = 0; j < ntw; j++) waveX.push(ntw === 1 ? 0 : -maxBeam / 2 + (maxBeam * j) / (ntw - 1));

  const g: HullGeom = {
    cols, strips, stripZ, dz, zBow, zStern, chineBeam: Math.max(0.3, chineBeam), maxBeam, deadriseDeg, keelSlope,
    zWlBow: Number.isFinite(zF) ? zF : zBow, waterlineY, volume: vol, lwl, bwl, draft, cb, s0, contacts, waveX, waveZ,
  };
  byMass.set(mass, g);
  return g;
}

// ─── The sea surface over the hull ─────────────────────────────────────────────────────────────

const specCache = new WeakMap<object, WaveSpectrum>();
function seaSpectrum(cfg: Config): WaveSpectrum {
  let s = specCache.get(cfg.world.water);
  if (!s) {
    s = getSeaSpectrum(cfg);
    specCache.set(cfg.world.water, s);
  }
  return s;
}

/** The sea shader's shoaling: waves shrink over shallow water (src/world/traffic/buoyancy.ts shoalFactor). */
const shoal = (depth: number): number => 0.3 + 0.7 * smoothstep(0.3, 8, depth);

/**
 * Gerstner height and vertical velocity above world (x, z) at time t (× gain), inverting the
 * horizontal displacement by fixed-point iteration (a contraction: Σ k s ≤ choppiness < 1).
 */
function waveAt(spec: WaveSpectrum, gain: number, x: number, z: number, t: number, out: { h: number; vy: number }): void {
  out.h = 0;
  out.vy = 0;
  if (!(gain > 0)) return;
  const tr = spec.trains;
  let x0 = x;
  let z0 = z;
  for (let it = 0; it < 5; it++) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < tr.length; i++) {
      const w = tr[i];
      const c = Math.cos(w.k * (w.dirX * x0 + w.dirZ * z0) - w.omega * t + w.phase);
      dx += w.chop * w.dirX * c;
      dz += w.chop * w.dirZ * c;
    }
    x0 = x - gain * dx;
    z0 = z - gain * dz;
  }
  let h = 0;
  let vy = 0;
  for (let i = 0; i < tr.length; i++) {
    const w = tr[i];
    const th = w.k * (w.dirX * x0 + w.dirZ * z0) - w.omega * t + w.phase;
    h += w.amp * Math.sin(th);
    vy -= w.amp * w.omega * Math.cos(th);
  }
  out.h = h * gain;
  out.vy = vy * gain;
}

interface SeaPatch {
  /** Still-water level under the hull (sea, lake or river), or null on dry land. */
  level: number | null;
  /** Wave height / vertical velocity at the sample grid [iz * nx + ix]. */
  h: Float64Array;
  vy: Float64Array;
}

function samplePatch(g: HullGeom, pos: Vec3, q: Quat, t: number, env: Environment, cfg: Config): SeaPatch {
  const nx = g.waveX.length;
  const nz = g.waveZ.length;
  const h = new Float64Array(nx * nz);
  const vy = new Float64Array(nx * nz);
  const level = env.waterLevel(pos.x, pos.z);
  if (level === null) return { level, h, vy };
  // Waves only on the open sea (lakes and the river are drawn nearly flat at this scale).
  const isSea = Math.abs(level - cfg.world.seaLevel) < 1e-3;
  if (!isSea) return { level, h, vy };
  const gain = shoal(level - env.groundHeight(pos.x, pos.z));
  const spec = seaSpectrum(cfg);
  const o = { h: 0, vy: 0 };
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const w = bodyToWorld(q, { x: g.waveX[ix], y: 0, z: g.waveZ[iz] });
      waveAt(spec, gain, pos.x + w.x, pos.z + w.z, t, o);
      h[iz * nx + ix] = o.h;
      vy[iz * nx + ix] = o.vy;
    }
  }
  return { level, h, vy };
}

/** Bilinear interpolation of a patch field at body (x, z). */
function patchAt(g: HullGeom, f: Float64Array, x: number, z: number): number {
  const nx = g.waveX.length;
  const nz = g.waveZ.length;
  const fz = clamp(((z - g.zBow) / (g.zStern - g.zBow)) * (nz - 1), 0, nz - 1);
  const iz = Math.min(nz - 2, Math.floor(fz));
  const tz = fz - iz;
  let ix = 0;
  let tx = 0;
  if (nx > 1) {
    const fx = clamp(((x + g.maxBeam / 2) / g.maxBeam) * (nx - 1), 0, nx - 1);
    ix = Math.min(nx - 2, Math.floor(fx));
    tx = fx - ix;
  }
  const a = f[iz * nx + ix];
  const b = nx > 1 ? f[iz * nx + ix + 1] : a;
  const c = f[(iz + 1) * nx + ix];
  const d = nx > 1 ? f[(iz + 1) * nx + ix + 1] : c;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** The sea surface height (MSL) at a world point, as the physics sees it this step (for tests and effects). */
export function vesselSurfaceAt(env: Environment, x: number, z: number, t: number, cfg: Config = CONFIG): number | null {
  const level = env.waterLevel(x, z);
  if (level === null) return null;
  if (Math.abs(level - cfg.world.seaLevel) >= 1e-3) return level;
  const o = { h: 0, vy: 0 };
  waveAt(seaSpectrum(cfg), shoal(level - env.groundHeight(x, z)), x, z, t, o);
  return level + o.h;
}

// ─── Small helpers ─────────────────────────────────────────────────────────────────────────────

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Linear interpolation in an ascending [x, y] table (clamped). */
function table(t: readonly (readonly [number, number])[], x: number): number {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-9, x1 - x0);
    }
  }
  return t[t.length - 1][1];
}

/** Accumulates world forces and their moments about the CG. */
class Wrench {
  fx = 0;
  fy = 0;
  fz = 0;
  tx = 0;
  ty = 0;
  tz = 0;
  /** Add world force f at world offset r from the CG. */
  add(f: Vec3, r: Vec3): void {
    this.fx += f.x;
    this.fy += f.y;
    this.fz += f.z;
    this.tx += r.y * f.z - r.z * f.y;
    this.ty += r.z * f.x - r.x * f.z;
    this.tz += r.x * f.y - r.y * f.x;
  }
  force(f: Vec3): void {
    this.fx += f.x;
    this.fy += f.y;
    this.fz += f.z;
  }
  torque(t: Vec3): void {
    this.tx += t.x;
    this.ty += t.y;
    this.tz += t.z;
  }
}

// ─── Engines and propulsors ────────────────────────────────────────────────────────────────────

/** The lever → gearbox and the commanded engine rpm. */
export function leverCommand(lever: number, wc: WatercraftConfig): { gear: MarineGear; rpm: number } {
  const e = wc.engine;
  const a = Math.abs(lever);
  if (!(a > wc.neutralDetent)) return { gear: 'neutral', rpm: e.idleRpm };
  const f = (a - wc.neutralDetent) / (1 - wc.neutralDetent);
  const top = lever > 0 ? e.maxRpm : e.idleRpm + (e.maxRpm - e.idleRpm) * wc.asternRpmFraction;
  return { gear: lever > 0 ? 'ahead' : 'astern', rpm: e.idleRpm + (top - e.idleRpm) * f };
}

/** Largest steering angle at this speed (drives limit their angle at speed). */
export function maxSteerAt(p: PropulsorConfig, speedKt: number): number {
  const t = clamp(speedKt / Math.max(1, p.highSpeedKt), 0, 1);
  return p.maxSteerDeg + (p.highSpeedSteerDeg - p.maxSteerDeg) * t;
}

/** Foil lift coefficient with a soft stall. */
function foilCl(alpha: number, slope: number, stallDeg: number): number {
  const s = stallDeg * DEG;
  const a = Math.abs(alpha);
  if (a <= s) return slope * alpha;
  const post = slope * s * Math.max(0.55, 1 - (a - s) / (60 * DEG));
  return Math.sign(alpha) * post;
}

// ─── Strip planing (Sea-Doo work: hull.planingModel 'strips') ────────────────────────────────────

/** Cross-flow drag coefficient of a V section (Zarnick). */
const STRIP_CROSSFLOW_CD = 1.0;


const stripCache = new WeakMap<HullGeom, { chineHalf: Float64Array; tanBeta: Float64Array; keelY: Float64Array; deckY: Float64Array }>();

/** Each buoyancy strip's chine half-breadth, tan(deadrise), keel and deck height (cached per hull geometry). */
function stripGeom(geo: HullGeom, stations: readonly HullStation[]): { chineHalf: Float64Array; tanBeta: Float64Array; keelY: Float64Array; deckY: Float64Array } {
  let g = stripCache.get(geo);
  if (!g) {
    const n = geo.strips;
    g = { chineHalf: new Float64Array(n), tanBeta: new Float64Array(n), keelY: new Float64Array(n), deckY: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const st = stationAt(stations, geo.stripZ[i]);
      g.chineHalf[i] = Math.max(0.02, st.chineHalf);
      g.tanBeta[i] = st.chineHalf > 1e-3 ? Math.max(0.05, (st.chineY - st.keelY) / st.chineHalf) : 1;
      g.keelY[i] = st.keelY;
      g.deckY[i] = st.deckY;
    }
    stripCache.set(geo, g);
  }
  return g;
}

// ─── Waterjets (Sea-Doo work: PropulsorConfig.type 'jet') ─────────────────────────────────────────

/** What stepJet needs from the step (plain values; no allocation beyond a few small vectors). */
interface JetStep {
  q: Quat;
  pos: Vec3;
  /** Body velocity and body angular velocity. */
  vb: Vec3;
  w: Vec3;
  level: number | null;
  sea: SeaPatch;
  geo: HullGeom;
  rho: number;
  dt: number;
  running: boolean;
  starting: boolean;
  c: Controls;
  wc: WatercraftConfig;
  speedKt: number;
  helm: number;
  W: Wrench;
}

/** The iBR bucket position where the ahead and astern components of the jet cancel (the neutral detent). */
export function jetNeutralBucket(pc: PropulsorConfig): number {
  const j = pc.jet;
  if (!j) return 0;
  return 1 / (1 + j.reverseEfficiency * Math.cos(j.reverseAngleDeg * DEG));
}

/**
 * One waterjet for one step (see WaterjetConfig): the ECU's rpm command (throttle, iBR, off-throttle
 * assist, GPS speed limiter, ventilation cut), the engine's torque balance against the pump
 * (P = ½ ρ Q (Vj² − Va²) / η, Q = k (n − n_slip)), the gross jet thrust ρ Q Vj along the steered, trimmed nozzle
 * — or turned forward and down by the bucket — at the nozzle, the inlet momentum drag ρ Q Va at the
 * grate, and the fixed keel fin / sponsons as a foil. Adds its forces to x.W; returns the new state.
 */
function stepJet(pc: PropulsorConfig, ps: PropulsorState, x: JetStep): PropulsorState {
  const j = pc.jet!;
  const eng = x.wc.engine;
  const { q, vb, w, dt, c, rho } = x;
  const gr = Math.max(1e-6, eng.gearRatio);
  const prevJet = ps.jet;
  // Handlebars → nozzle (+ swings the jet to starboard: the stern goes to port, the bow to starboard).
  const steerDeg = moveToward(ps.steerDeg, x.helm * maxSteerAt(pc, x.speedKt), pc.steerRateDegPerSec * dt);
  const sd = steerDeg * DEG;
  // VTS nozzle trim (+ = jet aimed down: lifts the stern).
  const trimDeg = moveToward(prevJet?.trimDeg ?? pc.thrustAngleDeg, pc.thrustAngleDeg - c.elevatorTrim * j.trimRangeDeg, 12 * dt);
  const surfAt = (p: { x: number; z: number }) => (x.level === null ? -Infinity : x.level + patchAt(x.geo, x.sea.h, p.x, p.z));
  // Intake: water over the grate (its suction draws the surface down a little: full flow until the
  // grate is within ~3 cm of the surface, air only once it's ~3 cm clear): ventilation.
  // (the grate is ~25 cm wide: heeled, its low edge stays in the water)
  const inW = bodyToWorld(q, j.inlet);
  const gx = bodyToWorld(q, { x: 0.12, y: 0.12 * 0.4, z: 0 });
  const inletDepth = surfAt(j.inlet) - (x.pos.y + inW.y - Math.abs(gx.y));
  const imm = clamp((inletDepth + 0.03) / 0.06, 0, 1);
  const nzW = bodyToWorld(q, pc.position);
  const nozzleClear = x.pos.y + nzW.y - pc.diameter / 2 > surfAt(pc.position);

  // ── The ECU: rpm command and the bucket ──
  const cmd = leverCommand(c.throttle, x.wc);
  const bN = jetNeutralBucket(pc);
  let rpmCmd = cmd.rpm;
  let bucketT = cmd.gear === 'ahead' ? 0 : cmd.gear === 'astern' ? 1 : x.speedKt < 4 ? bN : 0;
  if (c.brake > 0.05) {
    // iBR brake: the bucket drops and the ECU raises the rpm to push against the flow.
    bucketT = 1;
    rpmCmd = Math.max(rpmCmd, eng.idleRpm + (eng.maxRpm * j.brakeRpmFraction - eng.idleRpm) * clamp(c.brake, 0, 1));
  } else if (cmd.gear === 'neutral' && Math.abs(x.helm) >= j.otas.helm && x.speedKt >= j.otas.minKt) {
    // Off-throttle assist: throttle released, bars hard over at speed → enough flow to steer.
    rpmCmd = Math.max(rpmCmd, j.otas.rpm);
  }
  // GPS speed limiter: pull the rpm back through a 3 kt band at the limit.
  const over = clamp((x.speedKt - (j.speedLimitKt - 1.5)) / 3, 0, 1);
  if (over > 0) rpmCmd = Math.min(rpmCmd, eng.maxRpm * (1 - 0.45 * over));
  // Ventilation protection: sucking air, the ECU cuts the rpm (the note drops in the air).
  const ventilation = 1 - imm;
  if (ventilation > 0.6) rpmCmd = Math.min(rpmCmd, j.ventRpm);
  const bucket = moveToward(prevJet?.bucket ?? bN, bucketT, j.bucketRatePerSec * dt);

  // ── Pump and engine ──
  const vIn = { x: vb.x + (w.y * j.inlet.z - w.z * j.inlet.y), z: vb.z + (w.x * j.inlet.y - w.y * j.inlet.x) };
  const Va = Math.max(0, -vIn.z) * j.inletRecovery;
  const nMax = eng.maxRpm / gr / 60;
  const qRated = eng.maxPowerW / (TAU * nMax);
  // (a fresh state starts the engine at idle)
  let n = x.running && !prevJet ? eng.idleRpm / gr / 60 : Math.max(0, ps.n);
  // cavitation: available suction head (atmosphere + ram) against what the impeller needs (∝ n²)
  const cavOf = (nn: number) => clamp((10.3 + (Va * Va) / 19.62) / Math.max(1e-6, j.npshAtMaxRpm * (nn / nMax) ** 2), 0.55, 1);
  const flowOf = (nn: number) => j.pumpFlowPerRev * Math.max(0, nn - j.slipRps) * imm * cavOf(nn);
  const pumpTorque = (nn: number) => {
    const Q = flowOf(nn);
    const Vj = Q / j.nozzleArea;
    const P = (0.5 * rho * Q * Math.max(0, Vj * Vj - Va * Va)) / j.pumpEfficiency;
    // + bearing / seal / air-pumping friction (~1.5 % of rated torque at full speed)
    return P / (TAU * Math.max(nn, 1)) + 0.015 * qRated * (nn / nMax);
  };
  let boost = ps.boost;
  let load = 0;
  const Qp = pumpTorque(n);
  if (x.running) {
    const engRpm = n * 60 * gr;
    const curve = eng.torqueRise + (1 - eng.torqueRise) * clamp((engRpm - eng.idleRpm) / (eng.maxRpm - eng.idleRpm), 0, 1);
    boost = moveToward(boost, clamp(0.1 + (0.9 * (engRpm - eng.idleRpm)) / (0.7 * (eng.maxRpm - eng.idleRpm)), 0.1, 1), dt / Math.max(0.02, eng.turboLagS));
    const qAvail = qRated * curve * (0.4 + 0.6 * boost);
    const qGov = Qp + eng.governorGain * (rpmCmd - engRpm) * gr;
    const Qe = engRpm > eng.maxRpm * 1.02 ? 0 : clamp(qGov, 0, qAvail);
    load = Qe / qRated;
    n += ((Qe - Qp) / eng.shaftInertia / TAU) * dt;
    const nIdle = eng.idleRpm / gr / 60;
    if (n < nIdle * 0.98) n = moveToward(n, nIdle, nIdle * 4 * dt);
  } else {
    // stopped (the pump drags it down) or cranking on the starter
    const target = x.starting ? 300 / gr / 60 : 0;
    // (compression and the pump stop it within a second or so)
    n = Math.max(0, moveToward(n - (Qp / eng.shaftInertia / TAU) * dt, target, ((x.starting ? 1500 : 5000) / gr / 60) * dt));
    boost = moveToward(boost, 0, dt / Math.max(0.02, eng.turboLagS));
  }
  n = Math.max(0, n);
  const rpm = n * 60 * gr;

  // ── Thrust ──
  const Q = flowOf(n);
  const Vj = Q / j.nozzleArea;
  const mdot = rho * Q;
  const Tg = mdot * Vj;
  const Di = mdot * Va;
  const ct = Math.cos(trimDeg * DEG);
  const st = Math.sin(trimDeg * DEG);
  const ra = j.reverseAngleDeg * DEG;
  const er = j.reverseEfficiency;
  // force on the hull (body): ahead along the nozzle; the bucket turns the jet forward and down (the
  // force astern and up), keeping its sideways component (steering still works in reverse)
  const fx = Tg * (-Math.sin(sd) * ct * (1 - bucket) - Math.sin(sd) * Math.cos(ra) * er * bucket);
  const fy = Tg * (st * (1 - bucket) + Math.sin(ra) * er * bucket);
  const fz = Tg * (-Math.cos(sd) * ct * (1 - bucket) + Math.cos(ra) * er * bucket);
  x.W.add(bodyToWorld(q, { x: fx, y: fy, z: fz }), nzW);
  // the inlet swallows the water's momentum: ahead (the ram drag) and sideways when skidding
  if (mdot > 0) x.W.add(bodyToWorld(q, { x: -mdot * vIn.x, y: 0, z: Di }), inW);
  const thrust = -fz - Di;

  // ── Fixed grip surfaces (they don't steer): a stubby, hull-bound surface doesn't stall so much as
  // turn into a plate across the flow — lift slope × sin α cos α plus Hoerner's cross-flow 1.2 sin α |sin α|
  const grip = (rf: { x: number; y: number; z: number }, area: number, imm: number) => {
    const vfx = vb.x + (w.y * rf.z - w.z * rf.y);
    const vfz = vb.z + (w.x * rf.y - w.y * rf.x);
    const V2 = vfx * vfx + vfz * vfz;
    if (!(imm > 0) || V2 <= 0.01) return;
    const alpha = Math.atan2(vfx, Math.abs(vfz));
    const sa = Math.sin(alpha);
    const cl = pc.foilLiftSlope * sa * Math.cos(alpha) + 1.2 * sa * Math.abs(sa);
    const qd = 0.5 * rho * V2 * area * imm;
    const V = Math.sqrt(V2);
    // lift ⟂ the flow, against the sideslip (half as effective going astern); a little drag along the flow
    const px = vfz / V;
    const pz = -vfx / V;
    const Lf = cl * qd * (vfz <= 0 ? 1 : -0.5);
    const Df = (0.012 + 0.1 * cl * cl) * qd;
    x.W.add(bodyToWorld(q, { x: px * Lf - (vfx / V) * Df, y: 0, z: pz * Lf - (vfz / V) * Df }), bodyToWorld(q, rf));
  };
  // the pump housing's keel, intake and ride plate: at foilCentre, gripping while the keel under it is wet
  {
    const rf = pc.foilCentre;
    const kW = bodyToWorld(q, { x: rf.x, y: stationAt(x.wc.hull.stations, rf.z).keelY, z: rf.z });
    grip(rf, pc.foilArea, clamp((surfAt(rf) - (x.pos.y + kW.y)) / 0.06, 0, 1));
  }
  // the sponsons: a fin on each side of the aft chines, just clear of the water on the plane — banked
  // into a turn the low one digs in and holds the stern (why the RXP-X's are adjustable)
  if (j.sponsons) {
    const sp = j.sponsons;
    for (const side of [-1, 1]) {
      const rs = { x: side * sp.x, y: sp.y, z: sp.z };
      const sW = bodyToWorld(q, rs);
      grip(rs, sp.area, clamp((surfAt(rs) - (x.pos.y + sW.y) + 0.5 * sp.depth) / sp.depth, 0, 1));
    }
  }

  const gear: MarineGear = !x.running ? 'neutral' : bucket < bN - 0.2 ? 'ahead' : bucket > bN + 0.15 ? 'astern' : 'neutral';
  return {
    rpm, n, gear, thrust, steerDeg, load, boost,
    jet: { bucket, trimDeg, flow: Q, jetSpeed: Vj, ventilation, nozzleClear },
  };
}

// ─── State creation ────────────────────────────────────────────────────────────────────────────

export interface VesselStart {
  x: number;
  z: number;
  headingDeg: number;
  /** Speed ahead through the water, kt (0 = at rest). Starting fast pre-runs the hull onto its running attitude. */
  speedKt?: number;
  /** Moored at this spot: lines hold the boat until the lever goes into gear. */
  moored?: boolean;
  /** The sea's wave clock at the start, s (the renderer's sea clock, so the hull sits on the drawn waves). */
  seaTime?: number;
}

function newPropulsors(wc: WatercraftConfig): PropulsorState[] {
  return wc.propulsors.map(() => ({ rpm: wc.engine.idleRpm, n: 0, gear: 'neutral' as MarineGear, thrust: 0, steerDeg: 0, load: 0.05, boost: 0 }));
}

function baseVesselState(wc: WatercraftConfig, seaTime: number, mooring: VesselState['mooring']): VesselState {
  return {
    seaTime,
    propulsors: newPropulsors(wc),
    tabs: 0,
    mooring,
    speedMs: 0,
    leewayDeg: 0,
    trimDeg: 0,
    planing: 0,
    wettedLength: 0,
    wettedArea: 0,
    displacedVolume: 0,
    resistance: 0,
    depthUnderKeel: Infinity,
    aground: false,
    touching: false,
    capsizeTime: 0,
    surfaceY: 0,
    ...(wc.rider ? { rider: newRider() } : {}),
    ...(wc.righting ? { righting: 0 } : {}),
  };
}

/** Sea-Doo: a rider sitting square on the seat. */
function newRider(): RiderState {
  return { lean: 0, foreAft: 0, aboard: true, off: null, offTime: 0 };
}

const settleCache = new WeakMap<WatercraftConfig, Map<number, { dy: number; pitchDeg: number }>>();

/** Level-water equilibrium: the CG's height above the still level and the static trim (Newton on heave and pitch). */
export function staticFloat(cfg: Config): { dy: number; pitchDeg: number } {
  const wc = cfg.aircraft.watercraft!;
  const m = cfg.aircraft.mass;
  let byMass = settleCache.get(wc);
  if (!byMass) {
    byMass = new Map();
    settleCache.set(wc, byMass);
  }
  const hit = byMass.get(m);
  if (hit) return hit;
  const g = hullGeometry(wc, m);
  const rhoG = wc.waterDensity * cfg.sim.gravity;
  // residuals: net vertical force (buoyancy − weight) and pitch moment, for CG height y above level 0 and pitch θ
  const res = (y: number, th: number): [number, number] => {
    const q = quatFromEuler(0, th, 0);
    const up = bodyToWorld(q, { x: 0, y: 1, z: 0 });
    const cu = Math.max(0.35, Math.abs(up.y));
    let F = 0;
    let M = 0;
    for (const c of g.cols) {
      const b = bodyToWorld(q, { x: c.x, y: c.y, z: c.z });
      const t = bodyToWorld(q, { x: c.x, y: c.top, z: c.z });
      const y0 = y + Math.min(b.y, t.y);
      const y1 = y + Math.max(b.y, t.y);
      const sub = clamp(-y0, 0, y1 - y0);
      if (sub <= 0) continue;
      const f = (rhoG * c.area * sub) / cu;
      const lo = b.y < t.y ? b : t;
      const hi = b.y < t.y ? t : b;
      const k = sub / Math.max(1e-6, y1 - y0) / 2;
      const rz = lo.z + (hi.z - lo.z) * k;
      F += f;
      // world moment about x of an upward force at world z offset rz: torque.x = r.y f.z − r.z f.y = −rz f
      M += -rz * f;
    }
    return [F - m * cfg.sim.gravity, M];
  };
  let y = -g.waterlineY;
  let th = 0;
  for (let it = 0; it < 30; it++) {
    const [f0, m0] = res(y, th);
    if (Math.abs(f0) < 1e-3 * m * cfg.sim.gravity && Math.abs(m0) < 10) break;
    const ey = 1e-3;
    const et = 1e-3;
    const [f1, m1] = res(y + ey, th);
    const [f2, m2] = res(y, th + et);
    const a = (f1 - f0) / ey;
    const b = (f2 - f0) / et;
    const c = (m1 - m0) / ey;
    const d = (m2 - m0) / et;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) break;
    y -= clamp((d * f0 - b * m0) / det, -0.5, 0.5);
    th -= clamp((-c * f0 + a * m0) / det, -2, 2);
  }
  const out = { dy: y, pitchDeg: th };
  byMass.set(m, out);
  return out;
}

function vesselDerived(pos: Vec3, vel: Vec3, q: Quat, w: Vec3, loadFactor: number, v: VesselState): DerivedData {
  const e = eulerFromQuat(q);
  const { p, q: qr, r } = pqrFromOmega(w);
  const gs = Math.hypot(vel.x, vel.z);
  return {
    tas: Math.abs(v.speedMs),
    ias: Math.abs(v.speedMs),
    groundSpeed: gs,
    alpha: v.trimDeg * DEG,
    beta: v.leewayDeg * DEG,
    verticalSpeed: vel.y,
    altitudeAGL: pos.y - v.surfaceY,
    headingDeg: e.headingDeg,
    pitchDeg: e.pitchDeg,
    rollDeg: e.rollDeg,
    loadFactor,
    density: airDensity(pos.y),
    p,
    q: qr,
    r,
  };
}

function vesselEngine(v: VesselState, running: boolean, starting: boolean, startTimer: number, failed: boolean, wc?: WatercraftConfig): EngineState {
  const ps = v.propulsors;
  let load = 0;
  let thrust = 0;
  let k = 0;
  for (let i = 0; i < ps.length; i++) {
    if (wc?.propulsors[i]?.type === 'thruster') continue; // tunnel thrusters: not the engines
    load += ps[i].load;
    thrust += ps[i].thrust;
    k++;
  }
  return { running, starting, startTimer, failed, power: k ? clamp(load / k, 0, 1.2) : 0, rpm: ps.length ? ps[0].rpm : 0, thrust, afterburner: 0 };
}

// ─── Tunnel thrusters (type 'thruster'; the cruise-ship work) ───────────────────────────────────

/** A tunnel thruster's effectiveness at a speed through the water: full below 1 kt, nothing from `fadeKt`. */
export function thrusterEffect(speedKt: number, fadeKt: number): number {
  return 1 - smoothstep(Math.min(1, 0.2 * fadeKt), Math.max(0.5, fadeKt), Math.abs(speedKt));
}

/**
 * One tunnel thruster this step: athwartships thrust at its tunnel, driven by the helm's aileron axis
 * (+ = turn the bow to starboard: a bow thruster pushes to starboard, a stern thruster to port), faded
 * out with speed, following the helm at its electric rate, off with the engines (the gensets) or out of
 * the water. PropulsorState.thrust = the body-x force (N, + to starboard), load = |thrust| / max, n a
 * nominal impeller speed (rev/s) for the model.
 */
function stepThruster(pc: PropulsorConfig, ps: PropulsorState, aileron: number, running: boolean, speedKt: number, imm: number, dt: number): PropulsorState {
  const th = pc.thruster ?? { maxThrustN: 0, fadeKt: 5, ratePerSec: 0.25 };
  const side = pc.position.z <= 0 ? 1 : -1;
  const target = running ? clamp(aileron, -1, 1) * side * th.maxThrustN * thrusterEffect(speedKt, th.fadeKt) * imm : 0;
  const thrust = moveToward(Number.isFinite(ps.thrust) ? ps.thrust : 0, target, th.ratePerSec * th.maxThrustN * dt);
  const f = th.maxThrustN > 0 ? thrust / th.maxThrustN : 0;
  return { rpm: 0, n: 6 * f, gear: 'neutral', thrust, steerDeg: 0, load: Math.abs(f), boost: 0 };
}

/**
 * A vessel afloat at (x, z), bow on `headingDeg`, floating at its static waterline and trim on the
 * still level there, engines idling in neutral. Moored → lines to this spot. With `speedKt` the hull
 * is pre-run (a speed-holding helmsman, calm water) onto its running attitude and the controls that
 * hold that speed are returned.
 */
export function createVesselState(env: Environment, cfg: Config, start: VesselStart): { state: AircraftState; controls: Partial<Controls> } {
  const wc = cfg.aircraft.watercraft!;
  const level = env.waterLevel(start.x, start.z) ?? env.groundHeight(start.x, start.z);
  const fl = staticFloat(cfg);
  const heading = start.headingDeg;
  const orientation = quatFromEuler(heading, fl.pitchDeg, 0);
  const seaTime = start.seaTime ?? 0;
  const position = { x: start.x, y: level + fl.dy, z: start.z };
  const vessel = baseVesselState(wc, seaTime, start.moored ? { x: start.x, z: start.z, headingDeg: heading } : null);
  vessel.surfaceY = level;
  vessel.displacedVolume = hullGeometry(wc, cfg.aircraft.mass).volume;
  vessel.depthUnderKeel = Math.max(0, level - env.groundHeight(start.x, start.z) - hullGeometry(wc, cfg.aircraft.mass).draft);
  let state: AircraftState = {
    time: 0,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: vesselEngine(vessel, true, false, 0, false, wc),
    flapsDeg: 0,
    gearPos: 1,
    phase: 'afloat',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 0,
    touchdown: null,
    crash: null,
    derived: vesselDerived(position, ZERO, orientation, ZERO, 1, vessel),
    vessel,
  };
  const kt = start.speedKt ?? 0;
  if (!(kt > 0.5)) return { state, controls: { throttle: 0 } };

  // Pre-run in calm water (a flat, deep, obstacle-free copy of the world) with a speed-holding helmsman.
  const calm: Environment = {
    groundHeight: () => level - 1000,
    surfaceAt: () => 'water',
    waterLevel: () => level,
  };
  const target = kt / MS_TO_KT;
  const h = quatFromEuler(heading, 0, 0);
  const fwd = bodyToWorld(h, { x: 0, y: 0, z: -1 });
  let lever = clamp(0.3 + 0.7 * (kt / Math.max(34, cfg.aircraft.limits.vnoKt)), 0.15, 1);
  // the shafts start turning at the lever's rpm with the turbos / steam up (a heavy ship's plant takes
  // longer than the pre-run to spool from idle)
  const cmd = leverCommand(lever, wc);
  const spun = vessel.propulsors.map((p, i) =>
    wc.propulsors[i].type === 'thruster' ? p : { ...p, gear: cmd.gear, rpm: cmd.rpm, n: cmd.rpm / wc.engine.gearRatio / 60, boost: 1 },
  );
  state = { ...state, velocity: { x: fwd.x * target, y: 0, z: fwd.z * target }, vessel: { ...vessel, propulsors: spun, mooring: null } };
  const dt = cfg.sim.fixedDt;
  const cfgCalm: Config = { ...cfg, world: { ...cfg.world, seaLevel: level + 12345 } }; // never "the sea": no waves
  // The helmsman trims the lever on the surge ACCELERATION with the speed held at the target, so the
  // shafts, the trim and the squat settle at that speed whatever the vessel's size: a jet ski and a
  // 58,000 t battleship converge alike (a speed-error integrator winds a heavy ship's lever to the
  // detent long before its speed answers). The gain is normalised by the acceleration full power
  // would give at this speed (thrust ≈ power / speed).
  let power = 0;
  for (const p of wc.propulsors) if (p.type !== 'thruster') power += wc.engine.maxPowerW;
  const accelRef = Math.max(1e-3, power / (cfg.aircraft.mass * Math.max(target, 1)));
  const steps = Math.round(25 / dt);
  for (let i = 0; i < steps; i++) {
    state = stepVessel(state, { throttle: lever, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true }, dt, calm, cfgCalm);
    // keep it on the heading, on the line and at the speed; steer the lever by what the speed would do
    const sp = Math.hypot(state.velocity.x, state.velocity.z);
    const accel = (sp - target) / dt;
    lever = clamp(lever - (accel / accelRef) * dt * 1.5, wc.neutralDetent + 0.02, 1);
    const e = eulerFromQuat(state.orientation);
    const settle = i >= steps - Math.round(2 / dt);
    const hold = settle ? sp : target;
    if (!settle) {
      // the shafts held at the lever's governed rpm: the helmsman sees the propellers' answer at once,
      // not through a heavy plant's spool-up (the last seconds run free so the engines settle)
      const c = leverCommand(lever, wc);
      const n = c.rpm / wc.engine.gearRatio / 60;
      state = { ...state, vessel: { ...state.vessel!, propulsors: state.vessel!.propulsors.map((p, k) => (wc.propulsors[k].type === 'thruster' ? p : { ...p, gear: c.gear, rpm: c.rpm, n, boost: 1 })) } };
    }
    state = { ...state, orientation: quatFromEuler(heading, e.pitchDeg, e.rollDeg), position: { ...state.position, x: start.x, z: start.z } };
    state = { ...state, velocity: { x: fwd.x * hold, y: state.velocity.y, z: fwd.z * hold }, angularVelocity: { x: state.angularVelocity.x, y: 0, z: 0 } };
  }
  const y = state.position.y - level + (env.waterLevel(start.x, start.z) ?? level);
  const vs = state.vessel!;
  state = {
    ...state,
    time: 0,
    position: { x: start.x, y, z: start.z },
    vessel: { ...vs, seaTime, mooring: null, ...(vs.rider ? { rider: newRider() } : {}), ...(vs.righting !== undefined ? { righting: 0 } : {}) },
  };
  // (Sea-Doo: a small planing craft needs a margin on the throttle to stay over the hump in a seaway)
  if (wc.hull.planingModel === 'strips') lever = Math.min(1, lever + 0.04);
  return { state, controls: { throttle: lever } };
}

// ─── The step ──────────────────────────────────────────────────────────────────────────────────

function vesselCrash(s: AircraftState, reason: string, time: number): AircraftState {
  const v = s.velocity;
  const vessel = s.vessel!;
  const props = vessel.propulsors.map((p) => ({ ...p, rpm: 0, n: 0, thrust: 0, load: 0, boost: 0 }));
  const ves: VesselState = { ...vessel, propulsors: props, mooring: null };
  return {
    ...s,
    time,
    position: { ...s.position },
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { ...s.orientation },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: false, starting: false, startTimer: 0, failed: true, power: 0, rpm: 0, thrust: 0, afterburner: 0 },
    phase: 'crashed',
    stalled: false,
    crash: {
      time,
      reason,
      speedKt: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * MS_TO_KT,
      verticalSpeedFpm: v.y * 196.850394,
      position: { ...s.position },
    },
    vessel: ves,
  };
}

/** Controls for a vessel: the lever may go astern (−1); NaN → neutral. */
function sanitizeVessel(c: Controls): Controls {
  const n = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
  return {
    throttle: n(c.throttle, -1, 1),
    elevator: n(c.elevator, -1, 1),
    aileron: n(c.aileron, -1, 1),
    rudder: n(c.rudder, -1, 1),
    elevatorTrim: n(c.elevatorTrim, -1, 1),
    flapsNotch: 0,
    gearDown: true,
    brake: n(c.brake, 0, 1),
    parkingBrake: !!c.parkingBrake,
    engineOn: c.engineOn !== false,
  };
}

/**
 * Advance a vessel by dt (called by step() in ./aircraft.ts for configs with `watercraft`).
 * Pure: returns a new state.
 */
export function stepVessel(state: AircraftState, raw: Controls, dt: number, env: Environment, cfg: Config): AircraftState {
  const time = state.time + dt;
  if (state.phase === 'crashed') return { ...structuredClone(state), time };
  const ac = cfg.aircraft;
  const wc = ac.watercraft!;
  const hull = wc.hull;
  const c = sanitizeVessel(raw);
  const m = ac.mass;
  const grav = cfg.sim.gravity;
  const rho = wc.waterDensity;
  const geo = hullGeometry(wc, m);
  const pos = state.position;
  const vel = state.velocity;
  const q = state.orientation;
  const w = state.angularVelocity;
  const prevV = state.vessel ?? baseVesselState(wc, 0, null);
  const seaTime = prevV.seaTime + dt;
  const up = bodyToWorld(q, { x: 0, y: 1, z: 0 });
  const omegaW = bodyToWorld(q, w);
  const W = new Wrench();

  // ── The water over the hull ──
  const sea = samplePatch(geo, pos, q, seaTime, env, cfg);
  const level = sea.level;
  let surfaceY = env.groundHeight(pos.x, pos.z);
  if (level !== null) {
    const isSea = Math.abs(level - cfg.world.seaLevel) < 1e-3;
    const o = { h: 0, vy: 0 };
    if (isSea) waveAt(seaSpectrum(cfg), shoal(level - surfaceY), pos.x, pos.z, seaTime, o);
    surfaceY = level + o.h;
  }

  // ── Hydrostatics + vertical damping, column by column ──
  // At planing speed the transom runs dry and part of the hydrostatic pressure becomes the dynamic
  // lift below (Savitsky): fade that share out with the length Froude number.
  const vbPre = worldToBody(q, vel);
  const FnPre = Math.hypot(vbPre.x, vbPre.z) / Math.sqrt(grav * geo.lwl);
  const rhoG = rho * grav;
  // (Sea-Doo, strip planing: not once the hull is driven under — a buried hull keeps its buoyancy)
  const buried = hull.planingModel === 'strips' ? 1 - smoothstep(0.8, 1.5, prevV.displacedVolume / geo.volume) : 1;
  const hydro = 1 - (hull.planingLift > 0 ? hull.planingBuoyancyLoss * smoothstep(0.4, 1.3, FnPre) * (vbPre.z < 0 ? 1 : 0) * buried : 0);
  // The hull's own wave (ahead only): ζ(s) = a cos(k s), s aft of the bow crest, k = g / U².
  const Upre = -vbPre.z;
  const swA = Upre > 0.3 ? hull.selfWave * (geo.bwl / geo.lwl) * ((Upre * Upre) / (2 * grav)) * smoothstep(0.25, 0.4, FnPre) * (1 - smoothstep(hull.selfWaveFadeFn[0], hull.selfWaveFadeFn[1], FnPre)) : 0;
  const swK = Upre > 0.3 ? grav / (Upre * Upre) : 0;
  // …less its mean over the waterline: the wave system moves the pressure (bow up, stern down), it adds no displacement
  const swMean = swK > 0 ? Math.sin(swK * geo.lwl) / (swK * geo.lwl) : 0;
  const cu = Math.max(0.35, Math.abs(up.y));
  const bLin = hull.dampingLinear * rho * Math.sqrt(grav * geo.maxBeam);
  const bQuad = hull.dampingQuadratic * rho;
  let volume = 0;
  let wetArea = 0;
  let wetBottomArea = 0;
  let zFwdKeel = Infinity;
  let zFwdChine = Infinity;
  let zFwdAny = Infinity;
  let wetCz = 0;
  let wetCy = 0;
  let rockerSum = 0;
  // immersion-weighted lateral centroid of the wet bottom (the planing lift's lateral centre)
  let latW = 0;
  let latX = 0;
  const stripDepth = new Float64Array(geo.strips);
  // Sea-Doo: the keel's rocker per strip (the strip planing model)
  const stripRock = hull.planingModel === 'strips' ? new Float64Array(geo.strips) : null;
  // (…and each strip's deepest bottom immersion per side [port, starboard]: banked, the low side's
  // panel runs wet forward of where the keel does)
  const sideDepth = stripRock ? new Float64Array(2 * geo.strips) : null;
  if (level !== null) {
    for (const col of geo.cols) {
      const rb = bodyToWorld(q, { x: col.x, y: col.y, z: col.z });
      const rt = bodyToWorld(q, { x: col.x, y: col.top, z: col.z });
      const yb = pos.y + rb.y;
      const yt = pos.y + rt.y;
      const lo = Math.min(yb, yt);
      const hi = Math.max(yb, yt);
      const surf = level + patchAt(geo, sea.h, col.x, col.z) + (swA > 0 ? swA * (Math.cos(swK * Math.max(0, col.z - geo.zWlBow)) - swMean) : 0);
      const sub = clamp(surf - lo, 0, hi - lo);
      if (sub <= 0) continue;
      const vol = (col.area * sub) / cu;
      volume += vol;
      // centroid of the wet part: from the low end up the column
      const rLo = yb <= yt ? rb : rt;
      const rHi = yb <= yt ? rt : rb;
      const k = sub / Math.max(1e-6, hi - lo) / 2;
      const r = { x: rLo.x + (rHi.x - rLo.x) * k, y: rLo.y + (rHi.y - rLo.y) * k, z: rLo.z + (rHi.z - rLo.z) * k };
      W.add({ x: 0, y: rhoG * vol * hydro, z: 0 }, r);
      // vertical damping relative to the moving surface (ramped in over the first 10 cm of immersion)
      const vp = cross(omegaW, rLo);
      const vrel = vel.y + vp.y - patchAt(geo, sea.vy, col.x, col.z);
      const wet = Math.min(1, sub / 0.1);
      const fd = -col.area * wet * (bLin * vrel + bQuad * vrel * Math.abs(vrel));
      W.add({ x: 0, y: fd, z: 0 }, rLo);
      wetArea += col.surface * wet;
      wetCz += col.z * col.surface * wet;
      wetCy += col.y * col.surface * wet;
      if (col.bottom) {
        wetBottomArea += col.area * wet;
        rockerSum += col.rocker * col.area * wet;
        const wgt = col.area * Math.min(sub, 0.6);
        latW += wgt;
        latX += wgt * col.x;
      }
      const zf = col.z - geo.dz / 2;
      if (zf < zFwdAny) zFwdAny = zf;
      if (col.centre && zf < zFwdKeel) zFwdKeel = zf;
      if (col.chine && zf < zFwdChine) zFwdChine = zf;
      if (col.centre) stripDepth[col.strip] = Math.max(stripDepth[col.strip], sub / cu);
      if (stripRock && col.centre) stripRock[col.strip] = col.rocker;
      if (sideDepth && col.bottom) {
        const k = 2 * col.strip + (col.x > 0 ? 1 : 0);
        sideDepth[k] = Math.max(sideDepth[k], sub / cu);
      }
    }
  }
  const immersion = clamp(volume / geo.volume, 0, 1.5);
  const wetted = wetArea > 1e-6;
  const wetLen = wetted ? Math.max(0.1, geo.zStern - zFwdAny) : 0;
  if (wetted) {
    wetCz /= wetArea;
    wetCy /= wetArea;
  }

  // ── Flow over the hull (water at rest; the waves' orbital drift is second order at these scales) ──
  const vb = worldToBody(q, vel);
  const u = -vb.z;
  const vSide = vb.x;
  const Vh = Math.hypot(u, vSide);
  const speedKt = Math.abs(u) * MS_TO_KT;
  // Running trim: the flow's angle to the body, plus the mean rocker of the wetted bottom (the
  // forefoot meets the water at an angle; it fades as the bow lifts clear and only the flat aft
  // buttocks run wet — then this is Savitsky's trim of the keel).
  const rocker = wetBottomArea > 1e-6 ? rockerSum / wetBottomArea : 0;
  const trimRad = Math.atan2(-vb.y, Math.max(0.5, Math.abs(u))) + rocker;
  const trimDeg = trimRad / DEG;
  const leewayDeg = Vh > 0.3 ? Math.atan2(vSide, Math.abs(u)) / DEG : 0;
  const Uref = Math.max(0.5, Vh);

  // ── Planing lift (Savitsky, dynamic part) ──
  let planingLift = 0;
  if (hull.planingLift > 0 && wetted && u > 0.5 && !stripRock) {
    const B = geo.chineBeam;
    const Lk = Number.isFinite(zFwdKeel) ? geo.zStern - zFwdKeel : 0;
    const Lc = Number.isFinite(zFwdChine) ? geo.zStern - zFwdChine : 0;
    const lambda = clamp((Lk + Lc) / (2 * B), 0.3, 8);
    const tau = clamp(trimDeg, 0, hull.planingMaxTrimDeg);
    const cl0 = Math.pow(tau, 1.1) * 0.012 * Math.sqrt(lambda);
    const clb = Math.max(0, cl0 - 0.0065 * geo.deadriseDeg * Math.pow(cl0, 0.6));
    // negative trim digs the bow in: a small down force instead of lift
    const neg = trimDeg < 0 ? -Math.min(2, -trimDeg) * 0.004 * Math.sqrt(lambda) : 0;
    // the lift needs a wetted bottom; fade it as the bottom leaves the water
    const wetFrac = clamp(wetBottomArea / (0.25 * geo.lwl * B), 0, 1);
    const L = 0.5 * rho * u * u * B * B * (clb + neg) * hull.planingLift * wetFrac;
    const Cv = u / Math.sqrt(grav * B);
    const lp = clamp(lambda * B * (0.75 - 1 / ((5.21 * Cv * Cv) / (lambda * lambda) + 2.39)), 0, geo.zStern - geo.zBow);
    const zCp = geo.zStern - lp;
    const st = stationAt(hull.stations, zCp);
    // laterally at the wet bottom's immersion centroid: the deeper side of a heeled V-bottom carries
    // more of the pressure, which is what keeps a planing hull upright once the buoyancy has faded
    // …and toward the side leading into a sideslip: skidding sideways, the leading half of the V
    // meets the flow at a larger angle (β / tan deadrise) — why a planing hull banks INTO a turn
    const slip = Math.atan2(vSide, Math.max(0.5, u));
    const lead = geo.deadriseDeg > 1 ? clamp(slip / Math.tan(geo.deadriseDeg * DEG), -1, 1) : 0;
    const xCp = clamp((latW > 0 ? latX / latW : 0) + 0.5 * B * lead, -0.5 * B, 0.5 * B);
    const r = bodyToWorld(q, { x: xCp, y: 0.5 * (st.keelY + st.chineY), z: zCp });
    W.add({ x: up.x * L, y: up.y * L, z: up.z * L }, r);
    planingLift = L;
    // pitch damping of the lift spread along the wet bottom: a pitch rate q changes the local angle
    // of attack by −q x / U along it, so M_q = −(dL/dτ) q Lw² / (12 U), dL/dτ ≈ 1.1 L / τ
    if (tau > 0.2 && L > 0) {
      const Lw = 0.5 * (Lk + Lc);
      const dLdTau = (1.1 * L) / (tau * DEG);
      const Mq = (-dLdTau * pqrFromOmega(w).q * Lw * Lw) / (12 * Math.max(1, u));
      // pitch moment M (+ nose up) → torque_body.x = +M
      W.torque(bodyToWorld(q, { x: Mq, y: 0, z: 0 }));
    }
  }

  // ── Sea-Doo: strip-theory planing (config hull.planingModel 'strips') ──
  // Each wet strip's two bottom panels (port, starboard) take a normal force: the rate the section's
  // added mass gains momentum as it passes aft (m_a = ρ π/4 c² a side, c the Wagner wetted half-beam
  // π/2 · d / tan β, capped at the chine) plus cross-flow drag (Zarnick 1978): f = U V dm_a/dξ +
  // C_dc ρ c/2 V|V|, V the water's speed into that panel — U × the local keel angle, less the strip's
  // own heave (pitch and roll rate × arm), plus the waves' orbital rise — faded toward the transom
  // (Garme 2005). Each side's panel wets from its own deepest immersion: banked, the low panel runs wet
  // forward of where the keel does and carries the load — the lift then tilts with the bank (the
  // carve's centripetal force) and its lateral centre moves to the low side (the roll stiffness);
  // skidding, the sideways flow loads the leading panel (a roll into the turn). Forefoot lift, heave /
  // pitch / roll damping and slamming all come out of it — what a short, light, fast hull needs
  // (Savitsky's prismatic fit doesn't hold when the wetted length jumps with a degree of trim). On the
  // plane these panel forces replace the displacement-hull side force below.
  let stripDyn = 0;
  if (stripRock && hull.planingLift > 0 && wetted && u > 0.5) {
    const sg = stripGeom(geo, hull.stations);
    const B = geo.chineBeam;
    const cv = Math.max(0.5, u / Math.sqrt(grav * B));
    const mPrev = [0, 0];
    for (let i = 0; i < geo.strips; i++) {
      const d = stripDepth[i];
      const dSide0 = sideDepth![2 * i];
      const dSide1 = sideDepth![2 * i + 1];
      if (d <= 0 && dSide0 <= 0 && dSide1 <= 0) {
        mPrev[0] = 0;
        mPrev[1] = 0;
        continue;
      }
      const z = geo.stripZ[i];
      const tb = sg.tanBeta[i];
      const beta = Math.atan(tb);
      const cb = Math.cos(beta);
      const sb = Math.sin(beta);
      // the water's rise into the bottom there: the keel's rocker meeting the flow, the waves' orbital rise
      const vn0 = u * Math.sin(stripRock[i]) + (level !== null ? patchAt(geo, sea.vy, 0, z) * up.y : 0);
      const garme = Math.tanh((2.5 * Math.max(0, geo.zStern - z)) / (B * cv));
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        const dS = k === 0 ? dSide0 : dSide1;
        if (dS <= 0) {
          mPrev[k] = 0;
          continue;
        }
        const c = Math.min(sg.chineHalf[i], ((Math.PI / 2) * dS) / tb);
        const ma = rho * (Math.PI / 4) * c * c;
        // the panel centroid's own motion (heave, roll, pitch) into the bottom
        const xP = side * 0.5 * c;
        const yP = sg.keelY[i] + 0.5 * c * tb;
        const hy = vb.y + (w.z * xP - w.x * z);
        const hxP0 = vSide + (w.y * z - w.z * yP);
        // the water's speed into the panel: its rise (rocker, waves) less the panel's heave, and — skidding —
        // the sideways flow onto the leading panel
        const v = cb * (vn0 - hy) + side * sb * hxP0;
        const fMom = Math.max(0, u * v * Math.max(0, ma - mPrev[k])) * hull.planingLift;
        const fCd = STRIP_CROSSFLOW_CD * rho * 0.5 * c * v * Math.abs(v) * geo.dz * (v > 0 ? 1 : 0.3);
        mPrev[k] = ma;
        // along the hull's normal (the strakes and chine flats carry much of a PWC bottom's load, so
        // the panels' inboard tilt is left out), at the panel: banked, the low panel lifts
        const f = ((fMom + fCd) * garme) / cb;
        W.add({ x: up.x * f, y: up.y * f, z: up.z * f }, bodyToWorld(q, { x: xP, y: yP, z }));
        planingLift += f;
      }
      // + radiation damping of the section's heave at speed (wave-making: ∝ U m_a / length), config
      const cs = Math.min(sg.chineHalf[i], ((Math.PI / 2) * d) / tb);
      const wSec = vb.y - w.x * z - (level !== null ? patchAt(geo, sea.vy, 0, z) * up.y : 0);
      const fRad = (-(hull.stripDamping ?? 0) * u * rho * (Math.PI / 2) * cs * cs * wSec * geo.dz) / Math.max(0.3, geo.lwl);
      W.add({ x: up.x * fRad, y: up.y * fRad, z: up.z * fRad }, bodyToWorld(q, { x: 0, y: sg.keelY[i], z }));
      planingLift += fRad;
    }
    stripDyn = clamp(planingLift / (m * grav), 0, 1);
    // the planing bottom's yaw damping (strakes and chines resisting the stern's swing), config:
    // N = −k ½ ρ U L_w³ B r
    const kNr = hull.stripYawDamping ?? 0;
    if (kNr > 0) {
      const Nr = -kNr * 0.5 * rho * u * wetLen * wetLen * wetLen * B * pqrFromOmega(w).r;
      W.torque(bodyToWorld(q, { x: 0, y: -Nr, z: 0 }));
    }
  }

  // ── Sea-Doo (strip planing): driven under (a nose-in), the whole hull ploughs — form drag against
  // its motion, the deck, hood and the rider's legs leading (a bluff body: Cd ~1.5 on its frontal area),
  // faded in as it buries — it stops the dive short and the foam-filled hull pops back up ──
  if (stripRock && immersion > 1) {
    const V = Math.hypot(vel.x, vel.y, vel.z);
    if (V > 0.1) {
      const D = 0.5 * rho * 1.5 * geo.maxBeam * 0.6 * clamp(immersion - 1, 0, 1) * V * V;
      W.force({ x: (-vel.x / V) * D, y: (-vel.y / V) * D, z: (-vel.z / V) * D });
    }
  }

  // ── Sea-Doo (strip planing): going astern, the flat transom leads — its immersed face pushes water ──
  if (stripRock && u < -0.05 && wetted) {
    const tr = hull.stations[hull.stations.length - 1];
    const dT = stripDepth[geo.strips - 1];
    const aT = 2 * Math.min(tr.chineHalf, (dT * tr.chineHalf) / Math.max(0.02, tr.chineY - tr.keelY)) * dT * 0.5 + Math.max(0, dT - (tr.chineY - tr.keelY)) * 2 * tr.chineHalf;
    const D = 0.5 * rho * 1.0 * aT * u * u;
    W.add(bodyToWorld(q, { x: 0, y: 0, z: -D }), bodyToWorld(q, { x: 0, y: tr.keelY + 0.5 * dT, z: tr.z }));
  }

  // ── Resistance: friction, residuary ──
  let resistance = 0;
  if (wetted && Vh > 0.01) {
    const Re = Math.max(1e5, (Vh * wetLen) / NU_WATER);
    const lg = Math.log10(Re) - 2;
    const cf = 0.075 / (lg * lg);
    const Rf = 0.5 * rho * Vh * Vh * wetArea * cf * hull.formFactor;
    const Fn = Vh / Math.sqrt(grav * geo.lwl);
    const Rr = 0.5 * rho * Vh * Vh * geo.s0 * table(hull.residuary, Fn) * Math.min(1, immersion);
    const R = Rf + Rr;
    resistance = R;
    // opposite the horizontal velocity through the water, at the wetted surface's centroid
    const dir = { x: -vb.x / Vh, y: 0, z: -vb.z / Vh };
    const fW = bodyToWorld(q, { x: dir.x * R, y: 0, z: dir.z * R });
    W.add(fW, bodyToWorld(q, { x: 0, y: wetCy, z: wetCz }));
  }

  // ── Manoeuvring: Clarke's linear derivatives + strip cross-flow drag ──
  // (Sea-Doo, strip planing: on the plane the V bottom's panels carry the linear side force instead;
  // the cross-flow drag of a hull skidding sideways stays, and — pressure on a V's panels — it acts
  // where their normals cross above the keel, not low in the water)
  const sideK = 1 - stripDyn;
  const sgm = stripRock ? stripGeom(geo, hull.stations) : null;
  const vMetaY = (i: number, d: number): number => {
    const tbm = sgm!.tanBeta[i];
    const cm = Math.min(sgm!.chineHalf[i], ((Math.PI / 2) * d) / tbm);
    return Math.min(sgm!.keelY[i] + 0.5 * cm * (tbm + 1 / tbm), sgm!.deckY[i]);
  };
  if (wetted && Vh > 0.05) {
    let aLat = 0;
    for (let i = 0; i < geo.strips; i++) aLat += stripDepth[i] * geo.dz;
    const L = Math.max(0.5, wetLen);
    const T = clamp(aLat / L, 0.02, 3 * geo.draft);
    const B = geo.bwl;
    const r = pqrFromOmega(w).r;
    const k = Math.PI * (T / L) * (T / L) * hull.clarkeScale;
    const Yv = -k * (1 + 0.4 * geo.cb * (B / T));
    const Yr = -k * (-0.5 + 2.2 * (B / L) - 0.08 * (B / T));
    const Nv = -k * (0.5 + 2.4 * (T / L));
    const Nr = -k * (0.25 + 0.039 * (B / T) - 0.56 * (B / L));
    const U = Uref;
    const Y = 0.5 * rho * L * L * U * (Yv * vSide + Yr * r * L);
    const N = 0.5 * rho * L * L * L * U * (Nv * vSide + Nr * r * L);
    W.add(bodyToWorld(q, { x: Y * sideK, y: 0, z: 0 }), bodyToWorld(q, { x: 0, y: geo.waterlineY - 0.5 * T, z: 0 }));
    W.torque(bodyToWorld(q, { x: 0, y: -N * sideK, z: 0 }));
    // cross-flow drag per strip (lateral velocity v + r × arm; arm + forward = −z)
    for (let i = 0; i < geo.strips; i++) {
      const d = stripDepth[i];
      if (d <= 0) continue;
      const z = geo.stripZ[i];
      const vl = vSide + r * -z;
      const f = -0.5 * rho * hull.crossFlowCd * d * geo.dz * vl * Math.abs(vl);
      W.add(bodyToWorld(q, { x: f, y: 0, z: 0 }), bodyToWorld(q, { x: 0, y: stripRock ? vMetaY(i, d) : geo.waterlineY - 0.5 * d, z }));
    }
  }
  // extra roll damping (chines, spray rails)
  if (wetted) {
    const p = pqrFromOmega(w).p;
    const L = -hull.rollDamping * rhoG * geo.volume * geo.maxBeam * p * Math.min(1, immersion);
    // roll moment L (+ right wing down) → torque_body.z = −L
    W.torque(bodyToWorld(q, { x: 0, y: 0, z: -L }));
  }

  // ── Windage (superstructure) ──
  {
    const wind = env.wind ? env.wind(pos.x, pos.y, pos.z, state.time) : ZERO;
    const ar = worldToBody(q, { x: wind.x - vel.x, y: 0, z: wind.z - vel.z });
    const rhoA = airDensity(pos.y);
    const wd = wc.windage;
    const f = { x: 0.5 * rhoA * wd.cdSide * wd.sideArea * ar.x * Math.abs(ar.x), y: 0, z: 0.5 * rhoA * wd.cdFront * wd.frontArea * ar.z * Math.abs(ar.z) };
    W.add(bodyToWorld(q, f), bodyToWorld(q, wd.centre));
  }

  // ── Engines, propellers, pods / rudders ──
  const eng = wc.engine;
  let engineRunning = state.engine.running;
  let starting = state.engine.starting;
  let startTimer = state.engine.startTimer;
  const failed = state.engine.failed;
  // Sea-Doo: the tether cord stops the engine while the rider is off
  const tetherOff = !!wc.rider && prevV.rider !== undefined && !prevV.rider.aboard;
  if (!c.engineOn || failed || tetherOff) {
    engineRunning = false;
    starting = false;
    startTimer = 0;
  } else if (!engineRunning) {
    starting = true;
    startTimer += dt;
    if (startTimer >= eng.startTime) {
      engineRunning = true;
      starting = false;
      startTimer = 0;
    }
  }
  const cmd = leverCommand(c.throttle, wc);
  // A vessel with tunnel thrusters: ← / → (aileron) drive the thrusters, A / D (rudder) alone the rudders.
  const hasThrusters = wc.propulsors.some((p) => p.type === 'thruster');
  const helm = clamp(c.rudder + (hasThrusters ? 0 : c.aileron), -1, 1);
  const nMaxProp = eng.maxRpm / eng.gearRatio / 60;
  const qRated = eng.maxPowerW / (TAU * nMaxProp);
  const props: PropulsorState[] = [];
  let totalThrust = 0;
  for (let i = 0; i < wc.propulsors.length; i++) {
    const pc = wc.propulsors[i];
    const ps = prevV.propulsors[i] ?? newPropulsors(wc)[0];
    // ── Tunnel thruster (cruise-ship work): athwartships thrust only, then the next propulsor ──
    if (pc.type === 'thruster') {
      const pwT = bodyToWorld(q, pc.position);
      const surfT = level === null ? -Infinity : level + patchAt(geo, sea.h, pc.position.x, pc.position.z);
      const immT = clamp((surfT - (pos.y + pwT.y) + pc.diameter / 2) / pc.diameter, 0, 1);
      const st = stepThruster(pc, ps, c.aileron, engineRunning, speedKt, immT, dt);
      W.add(bodyToWorld(q, { x: st.thrust, y: 0, z: 0 }), pwT);
      props.push(st);
      continue;
    }
    // Sea-Doo: a waterjet (stepJet) instead of a propeller
    if (pc.type === 'jet' && pc.jet) {
      const js = stepJet(pc, ps, { q, pos, vb, w, level, sea, geo, rho, dt, running: engineRunning, starting, c, wc, speedKt, helm, W });
      props.push(js);
      totalThrust += js.thrust;
      continue;
    }
    // steering
    const steerTarget = helm * maxSteerAt(pc, speedKt);
    const steerDeg = moveToward(ps.steerDeg, steerTarget, pc.steerRateDegPerSec * dt);
    const sd = steerDeg * DEG;
    // the drive's axis (forward along the thrust line); + steer swings the thrust to port → the stern to port → the bow to starboard
    const axis = pc.type === 'pod' ? { x: -Math.sin(sd), y: 0, z: -Math.cos(sd) } : { x: 0, y: 0, z: -1 };
    // local water flow at the propeller
    const rp = pc.position;
    const vpB = { x: vb.x + (w.y * rp.z - w.z * rp.y), y: vb.y + (w.z * rp.x - w.x * rp.z), z: vb.z + (w.x * rp.y - w.y * rp.x) };
    const va = (vpB.x * axis.x + vpB.z * axis.z) * (1 - pc.wakeFraction);
    // immersion of the propeller (ventilates as it leaves the water)
    const pw = bodyToWorld(q, rp);
    const propY = pos.y + pw.y;
    const surfP = level === null ? -Infinity : level + patchAt(geo, sea.h, rp.x, rp.z);
    const imm = clamp((surfP - (propY - pc.diameter / 2)) / pc.diameter, 0, 1);
    const D = pc.diameter;
    // shaft dynamics
    const gear: MarineGear = engineRunning ? cmd.gear : 'neutral';
    const dir = gear === 'ahead' ? 1 : gear === 'astern' ? -1 : 0;
    let n = ps.n;
    const J = Math.abs(n) > 0.3 ? va / (n * D) : 0;
    const kq = clamp(pc.kq0 * (1 - J / pc.j0Q), -pc.kq0, 2 * pc.kq0) * (0.15 + 0.85 * imm);
    const kt = clamp(pc.kt0 * (1 - J / pc.j0T), -pc.kt0, 2 * pc.kt0) * imm;
    const Qp = kq * rho * n * Math.abs(n) * D ** 5;
    let rpm: number;
    let boost = ps.boost;
    let load = 0;
    if (dir !== 0) {
      const engRpm = Math.abs(n) * 60 * eng.gearRatio;
      const curve = eng.torqueRise + (1 - eng.torqueRise) * clamp((engRpm - eng.idleRpm) / (eng.maxRpm - eng.idleRpm), 0, 1);
      // the turbo: full boost from ~60 % rpm under load (exhaust flow), building with the lag
      boost = moveToward(boost, clamp(0.15 + (0.85 * (engRpm - eng.idleRpm)) / (0.55 * (eng.maxRpm - eng.idleRpm)), 0.15, 1), dt / Math.max(0.05, eng.turboLagS));
      const qAvail = qRated * curve * (0.35 + 0.65 * boost);
      // governor: carry the propeller's load, correct the rpm error (engine rpm → shaft torque), never over max rpm
      const err = cmd.rpm - engRpm;
      const qGov = Math.abs(Qp) * (dir * n >= 0 ? 1 : -1) + eng.governorGain * err * eng.gearRatio;
      const Qe = engRpm > eng.maxRpm * 1.02 ? 0 : clamp(qGov, 0, qAvail);
      load = Qe / qRated;
      const omega = TAU * n + ((dir * Qe - Qp) / eng.shaftInertia) * dt;
      n = omega / TAU;
      // an idling engine in gear never stalls: at least idle rpm in the selected direction
      const nIdle = eng.idleRpm / eng.gearRatio / 60;
      if (dir * n < nIdle * 0.98 && Math.abs(Qp) < qAvail) n = moveToward(n, dir * nIdle, nIdle * 4 * dt);
      rpm = Math.abs(n) * 60 * eng.gearRatio;
    } else {
      // neutral: the engine spins free toward idle (or down when stopped); the propeller windmills down
      // (the starter cranks at ~200 rpm until it catches)
      const target = engineRunning ? eng.idleRpm : starting ? 200 : 0;
      rpm = moveToward(ps.rpm, target, (engineRunning || starting ? 3000 : 900) * dt);
      boost = moveToward(boost, 0.1, dt / Math.max(0.05, eng.turboLagS));
      const omega = TAU * n - (Qp / (eng.shaftInertia * 0.3)) * dt;
      n = Math.abs(omega) < 0.05 ? 0 : omega / TAU;
      load = engineRunning ? 0.05 : 0;
    }
    // thrust (along the drive's axis), astern efficiency, thrust deduction
    let T = kt * rho * n * Math.abs(n) * D ** 4;
    if (T < 0) T *= pc.asternEfficiency;
    const Teff = T * (1 - pc.thrustDeduction);
    const ta = pc.thrustAngleDeg * DEG;
    W.add(bodyToWorld(q, { x: axis.x * Teff * Math.cos(ta), y: Teff * Math.sin(ta), z: axis.z * Teff * Math.cos(ta) }), pw);
    totalThrust += T;
    // the leg / rudder as a foil (in the propeller's slipstream for rudders)
    const rf = pc.foilCentre;
    const vf = { x: vb.x + (w.y * rf.z - w.z * rf.y), z: vb.z + (w.x * rf.y - w.y * rf.x) };
    const fw = bodyToWorld(q, rf);
    const surfF = level === null ? -Infinity : level + patchAt(geo, sea.h, rf.x, rf.z);
    const fImm = clamp((surfF - (pos.y + fw.y)) / 0.3 + 0.5, 0, 1);
    const V2 = vf.x * vf.x + vf.z * vf.z;
    if (fImm > 0 && V2 > 0.01) {
      const chord = { x: -Math.sin(sd), z: -Math.cos(sd) };
      const nrm = { x: -chord.z, z: chord.x };
      const vc = vf.x * chord.x + vf.z * chord.z;
      const vn = vf.x * nrm.x + vf.z * nrm.z;
      const alpha = Math.atan2(vn, Math.abs(vc));
      let qd = 0.5 * rho * V2;
      if (pc.type === 'shaft' && T > 0) qd += T / (Math.PI * D * D * 0.25);
      const cl = foilCl(alpha, pc.foilLiftSlope, pc.foilStallDeg) * (vc < 0 ? 0.5 : 1);
      // lift ⟂ the flow, resisting the sideslip across the foil; plus a little drag along the flow
      const V = Math.sqrt(V2);
      const vhat = { x: vf.x / V, z: vf.z / V };
      let px = nrm.x - (nrm.x * vhat.x + nrm.z * vhat.z) * vhat.x;
      let pz = nrm.z - (nrm.x * vhat.x + nrm.z * vhat.z) * vhat.z;
      const pl = Math.hypot(px, pz);
      if (pl > 1e-6) {
        px /= pl;
        pz /= pl;
        const Lf = -cl * qd * pc.foilArea * fImm;
        const Df = -(0.012 + 0.1 * cl * cl) * qd * pc.foilArea * fImm;
        W.add(bodyToWorld(q, { x: px * Lf + vhat.x * Df, y: 0, z: pz * Lf + vhat.z * Df }), fw);
      }
    }
    props.push({ rpm, n, gear, thrust: T, steerDeg, load, boost });
  }

  // ── Trim tabs ──
  const tabs = wc.trimTabs ? moveToward(prevV.tabs, clamp(-c.elevatorTrim, 0, 1), wc.trimTabs.ratePerSec * dt) : 0;
  if (wc.trimTabs && tabs > 0 && u > 0.5) {
    for (const p of wc.trimTabs.positions) {
      const pw = bodyToWorld(q, p);
      const surfT = level === null ? -Infinity : level + patchAt(geo, sea.h, p.x, p.z);
      if (pos.y + pw.y > surfT + 0.05) continue;
      const Lt = 0.5 * rho * u * u * wc.trimTabs.area * wc.trimTabs.clFull * tabs;
      W.add(bodyToWorld(q, { x: 0, y: Lt, z: 0.08 * Lt }), pw);
    }
  }

  // ── Mooring lines ──
  let mooring = prevV.mooring;
  if (mooring && cmd.gear !== 'neutral' && engineRunning) mooring = null;
  if (mooring) {
    const mo = wc.mooring;
    W.force({ x: -mo.stiffness * (pos.x - mooring.x) - mo.damping * vel.x, y: 0, z: -mo.stiffness * (pos.z - mooring.z) - mo.damping * vel.z });
    const e = eulerFromQuat(q);
    const dpsi = wrap180(e.headingDeg - mooring.headingDeg) * DEG;
    const r = pqrFromOmega(w).r;
    // yaw moment N (+ nose right) → torque_body.y = −N
    W.torque(bodyToWorld(q, { x: 0, y: -(-mo.yawStiffness * dpsi - mo.yawDamping * r), z: 0 }));
  }

  // ── Contacts: sea bed / shore, structures ──
  const ct = wc.contact;
  let aground = false;
  let touching = false;
  let crashReason: string | null = null;
  let depthUnderKeel = Infinity;
  const ptW: Vec3[] = [];
  for (const b of geo.contacts) ptW.push(bodyToWorld(q, b));
  // broad phase: the ground at the CG and the hull's ends, against the hull's lowest point
  let lowest = Infinity;
  for (const r of ptW) lowest = Math.min(lowest, pos.y + r.y);
  const probe = [0, geo.zBow, geo.zStern];
  let groundTop = -Infinity;
  for (const z of probe) {
    const r = bodyToWorld(q, { x: 0, y: 0, z });
    groundTop = Math.max(groundTop, env.groundHeight(pos.x + r.x, pos.z + r.z));
  }
  const nearBottom = groundTop > lowest - 4;
  const checkObstacles = typeof env.obstacleTop === 'function';
  const checkSoft = typeof env.softObstacleTop === 'function'; // offshore work: race buoys
  for (let i = 0; i < ptW.length; i++) {
    const r = ptW[i];
    const P = { x: pos.x + r.x, y: pos.y + r.y, z: pos.z + r.z };
    const vp = cross(omegaW, r);
    const vP = { x: vel.x + vp.x, y: vel.y + vp.y, z: vel.z + vp.z };
    if (nearBottom) {
      const g = env.groundHeight(P.x, P.z);
      if (P.y - g < depthUnderKeel && i < geo.contacts.length) depthUnderKeel = Math.min(depthUnderKeel, P.y - g);
      if (P.y < g) {
        const pen = g - P.y;
        aground = true;
        const nrm = env.groundNormal ? env.groundNormal(P.x, P.z) : { x: 0, y: 1, z: 0 };
        const vn = vP.x * nrm.x + vP.y * nrm.y + vP.z * nrm.z;
        // hitting the bottom hard, or at speed at all (a planing hull or its drives don't survive it)
        if (-vn > ct.crashSpeedMs * 1.5 || Math.hypot(vP.x, vP.z) > ct.crashSpeedMs * 2) crashReason = 'Ran aground — hull holed';
        const fn = Math.max(0, ct.stiffness * pen - ct.damping * vn);
        const vt = { x: vP.x - vn * nrm.x, y: vP.y - vn * nrm.y, z: vP.z - vn * nrm.z };
        const vtl = Math.hypot(vt.x, vt.y, vt.z);
        const ff = vtl > 1e-3 ? (ct.friction * fn) / Math.max(vtl, 0.2) : 0;
        W.add({ x: nrm.x * fn - vt.x * ff, y: nrm.y * fn - vt.y * ff, z: nrm.z * fn - vt.z * ff }, r);
      }
    }
    if (checkObstacles && P.y < (level ?? P.y) + 3) {
      const top = env.obstacleTop!(P.x, P.z);
      if (top > P.y) {
        // push the hull back inboard: outward = the point's horizontal offset from the CG
        let nx = r.x;
        let nz = r.z;
        const nl = Math.hypot(nx, nz);
        if (nl < 1e-3) continue;
        nx /= nl;
        nz /= nl;
        // penetration: march inboard until the structure ends
        let pen = 0.05;
        for (const s of [0.1, 0.2, 0.4, 0.8, 1.6]) {
          pen = s;
          if (env.obstacleTop!(P.x - nx * s, P.z - nz * s) <= P.y) break;
        }
        const vn = vP.x * nx + vP.z * nz; // + = moving further into it
        touching = true;
        if (vn > ct.crashSpeedMs) crashReason = 'Collision — hull holed';
        const fn = Math.max(0, ct.stiffness * pen + ct.damping * vn);
        const vt = { x: vP.x - vn * nx, y: vP.y, z: vP.z - vn * nz };
        const vtl = Math.hypot(vt.x, vt.y, vt.z);
        const ff = vtl > 1e-3 ? (ct.friction * fn) / Math.max(vtl, 0.2) : 0;
        W.add({ x: -nx * fn - vt.x * ff, y: -vt.y * ff, z: -nz * fn - vt.z * ff }, r);
      }
    }
    // ── Offshore work: soft obstacles (inflatable buoys) — a gentle push away, never a crash ──
    if (checkSoft && P.y < (level ?? P.y) + 1.5) {
      const top = env.softObstacleTop!(P.x, P.z);
      if (top > P.y) {
        let nx = r.x;
        let nz = r.z;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-3) {
          nx /= nl;
          nz /= nl;
          let pen = 0.05;
          for (const s of [0.1, 0.2, 0.4, 0.8, 1.6]) {
            pen = s;
            if (env.softObstacleTop!(P.x - nx * s, P.z - nz * s) <= P.y) break;
          }
          const vn = vP.x * nx + vP.z * nz;
          // an inflatable buoy on a slack mooring is shoved aside / under: a firm but capped push
          // (≤ 0.3 g on the whole hull) — the boat bumps it and slows a little, it isn't holed
          const fn = Math.min(m * grav * 0.3, m * grav * 0.6 * pen + m * 0.3 * Math.max(0, vn));
          touching = true;
          W.add({ x: -nx * fn, y: 0, z: -nz * fn }, r);
        }
      }
    }
    // ── end offshore ──
  }
  if (!nearBottom && level !== null) depthUnderKeel = Math.max(0, lowest - groundTop);

  // ── Sea-Doo: the rider shifting their weight (a pure moment about the CG), and spills ──
  const rc = wc.rider;
  let rider = prevV.rider;
  if (rc) {
    const r0 = prevV.rider ?? newRider();
    const on = r0.aboard;
    // the rider balances like a skier: toward the bank that loads the seat squarely (atan U r / g) plus
    // the carve you ask for (← / →: full lean-in intent; A / D: half), against the roll rate
    const intent = clamp(c.aileron + rc.leanFromRudder * c.rudder, -1, 1);
    const bankNow = eulerFromQuat(q).rollDeg * DEG;
    // (they coordinate the turn they're steering; with the bars straight they hold it level)
    const steering = Math.min(1, Math.abs(c.rudder + c.aileron));
    const bankWant = steering * Math.atan2(u * pqrFromOmega(w).r, grav) + intent * rc.intentBankDeg * DEG;
    const leanT = on ? clamp(rc.bankGain * (bankWant - bankNow) - rc.rateGain * pqrFromOmega(w).p, -1, 1) : 0;
    const lean = moveToward(r0.lean, leanT, rc.leanRatePerSec * dt);
    const foreAft = moveToward(r0.foreAft, on ? clamp(-c.elevator, -1, 1) : 0, rc.leanRatePerSec * dt);
    if (on) {
      // their weight shifted across the seat, under the load they feel — along the hull's own "down"
      // (in a banked turn the turn loads them as much as the hull): body torque = r × (0, −n m g, 0)
      const rx = lean * rc.leanM;
      const rz = -foreAft * rc.foreAftM;
      const fg = rc.mass * grav * clamp(state.derived.loadFactor, 0.3, 3);
      W.torque(bodyToWorld(q, { x: rz * fg, y: 0, z: -rx * fg }));
    }
    rider = { ...r0, lean, foreAft };
    // a hard nose-in at speed throws the rider off: nose down, the bow's deck buried deep
    if (on && speedKt > rc.spillKt && level !== null && eulerFromQuat(q).pitchDeg < -rc.spillPitchDeg) {
      const st0 = hull.stations[1];
      const bw = bodyToWorld(q, { x: 0, y: st0.deckY, z: st0.z });
      if (level + patchAt(geo, sea.h, 0, st0.z) - (pos.y + bw.y) > rc.spillDepthM) rider = { ...rider, aboard: false, off: 'spill', offTime: 0 };
    }
  }

  // ── Integrate (semi-implicit Euler, added mass per body axis scaled by the immersion) ──
  W.force({ x: 0, y: -m * grav, z: 0 });
  const am = hull.addedMass;
  const imm = clamp(immersion, 0, 1);
  const fb = worldToBody(q, { x: W.fx, y: W.fy, z: W.fz });
  // gravity + buoyancy mostly act along world vertical: split them out so a rolled hull's added
  // mass along its own axes doesn't distort the weight
  const ab = {
    x: fb.x / (m * (1 + am.sway * imm)),
    y: fb.y / (m * (1 + am.heave * imm)),
    z: fb.z / (m * (1 + am.surge * imm)),
  };
  const aw = bodyToWorld(q, ab);
  const velocity = { x: vel.x + aw.x * dt, y: vel.y + aw.y * dt, z: vel.z + aw.z * dt };
  const position = { x: pos.x + velocity.x * dt, y: pos.y + velocity.y * dt, z: pos.z + velocity.z * dt };
  const tb = worldToBody(q, { x: W.tx, y: W.ty, z: W.tz });
  const I = ac.inertia;
  const Ip = I.pitch * (1 + am.pitch * imm);
  const Iy = I.yaw * (1 + am.yaw * imm);
  const Ir = I.roll * (1 + am.roll * imm);
  const hx = I.pitch * w.x;
  const hy = I.yaw * w.y;
  const hz = I.roll * w.z;
  const wMax = ac.limits.maxAngularRate;
  const angularVelocity = {
    x: clamp(w.x + ((tb.x - (w.y * hz - w.z * hy)) / Ip) * dt, -wMax, wMax),
    y: clamp(w.y + ((tb.y - (w.z * hx - w.x * hz)) / Iy) * dt, -wMax, wMax),
    z: clamp(w.z + ((tb.z - (w.x * hy - w.y * hx)) / Ir) * dt, -wMax, wMax),
  };
  let orientation = qIntegrateBody(q, angularVelocity, dt);

  // ── Capsize ──
  let e = eulerFromQuat(orientation);
  let capsizeTime = Math.abs(e.rollDeg) > ct.capsizeRollDeg || up.y < 0 ? prevV.capsizeTime + dt : 0;
  // Sea-Doo: capsized and nearly stopped, the rider swims round and rolls it back over (no wreck)
  let righting = prevV.righting ?? 0;
  if (wc.righting) {
    const rg = wc.righting;
    if (righting > 0) {
      const left = Math.max(dt, (1 - righting) * rg.durationS);
      righting = Math.min(1, righting + dt / rg.durationS);
      const f = bodyToWorld(orientation, { x: 0, y: 0, z: -1 });
      const hdg = Math.atan2(f.x, -f.z) / DEG;
      orientation = qSlerp(orientation, quatFromEuler(hdg, staticFloat(cfg).pitchDeg, 0), Math.min(1, dt / left));
      angularVelocity.x = 0;
      angularVelocity.y = 0;
      angularVelocity.z = 0;
      velocity.x *= 1 - Math.min(1, 2 * dt);
      velocity.z *= 1 - Math.min(1, 2 * dt);
      e = eulerFromQuat(orientation);
      capsizeTime = 0;
      if (righting >= 1) righting = 0;
    } else if (capsizeTime > rg.delayS && speedKt < rg.maxKt) righting = 1e-6;
  }
  if (rc && rider) {
    let rd = rider;
    if (rd.aboard && (Math.abs(e.rollDeg) > ct.capsizeRollDeg || up.y < 0)) rd = { ...rd, aboard: false, off: 'capsize', offTime: 0 };
    if (!rd.aboard) {
      rd = { ...rd, offTime: rd.offTime + dt };
      // climb back on: upright, not being righted, nearly stopped, after swimming back
      if (righting === 0 && Math.abs(e.rollDeg) < 30 && speedKt < rc.reboardKt && rd.offTime > rc.reboardS) rd = { ...rd, aboard: true, off: null, offTime: 0 };
    }
    rider = rd;
  }

  const vessel: VesselState = {
    seaTime,
    propulsors: props,
    tabs,
    mooring,
    speedMs: u,
    leewayDeg,
    trimDeg: e.pitchDeg,
    planing: clamp(planingLift / (m * grav), 0, 2),
    wettedLength: wetLen,
    wettedArea: wetArea,
    displacedVolume: volume,
    resistance,
    depthUnderKeel,
    aground,
    touching,
    capsizeTime,
    surfaceY,
    ...(rider ? { rider } : {}),
    ...(wc.righting ? { righting } : {}),
  };
  const loadFactor = (fb.y + m * grav * up.y) / (m * grav);
  const next: AircraftState = {
    time,
    position,
    velocity,
    orientation,
    angularVelocity,
    engine: vesselEngine(vessel, engineRunning, starting, startTimer, failed, wc),
    flapsDeg: 0,
    gearPos: 1,
    phase: 'afloat',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 0,
    touchdown: null,
    crash: null,
    derived: vesselDerived(position, velocity, orientation, angularVelocity, loadFactor, vessel),
    vessel,
  };
  if (crashReason) return vesselCrash({ ...next, velocity: vel }, crashReason, time);
  if (capsizeTime > ct.capsizeTimeS && !wc.righting) return vesselCrash(next, 'Capsized', time);
  if (!Number.isFinite(position.x + position.y + position.z + orientation.w)) return vesselCrash(state, 'Foundered', time);
  return next;
}
