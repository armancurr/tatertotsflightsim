/**
 * Marine wildlife (owned by src/world/wildlife): bottlenose dolphin pods in the bay and along the
 * coast (they come over and ride the bow wave of a boat driven at 6–25 kt, and play in the big
 * ships' bow waves), humpback whales offshore (blows, fluke-up dives, breaches), herring gulls
 * wheeling over the marina and harbour, perched on its structures, trailing the fishing boats and
 * following the player's boat, harbour seals hauled out on Seal Rock — and their sounds
 * (src/audio/wildlife.ts: gull calls, the "pfff" of a blow).
 *
 * Schedules run on the sea clock (`SystemFrame.waveTime`) and the traffic clock (a mirror of the
 * ships system's clock: same start, same steps), so everything but the bow riding and the gulls'
 * scattering is deterministic. `?no=wildlife` switches it all off; `?wildlifeT=<s>` shifts the
 * dolphins' and whales' schedules (QA photos of a particular moment).
 */
import * as THREE from 'three';
import { CONFIG, type WatercraftConfig } from '../../config';
import { createWildlife, type PlayerInfo } from '../../world/wildlife';
import { createTrafficClock, parseTrafficTime } from '../../world/traffic/clock';
import { syncLighting } from '../../world/traffic/daylight';
import { hullSize } from '../../world/traffic/hullTrack';
import { createWildlifeAudio, type WildlifeListener } from '../../audio/wildlife';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

const search = (): string => {
  try {
    return location.search;
  } catch {
    return '';
  }
};

function watercraftOf(def: AircraftDef | null | undefined): WatercraftConfig | null {
  if (!def) return null;
  const wc = (def.config.aircraft as { watercraft?: WatercraftConfig | null }).watercraft ?? null;
  return def.kind === 'vessel' || wc ? wc : null;
}

const mod: SystemModule = {
  name: 'wildlife',
  // after the traffic (ships 44) and the player's wake (47), before the effects
  order: 48,
  create(ctx) {
    const wild = createWildlife();
    ctx.scene.add(wild.group);
    const q = new URLSearchParams(search());
    const clock = createTrafficClock(parseTrafficTime(search()) ?? CONFIG.world.traffic.startTime);
    const offset = Number(q.get('wildlifeT') ?? 0) || 0;
    const audio = createWildlifeAudio();
    wild.onEvent = (kind, x, y, z, size) => audio.event(kind, x, y, z, size);

    let def: AircraftDef | null = ctx.actions?.currentAircraft?.() ?? null;
    let hull = (() => {
      const wc = watercraftOf(def);
      if (!wc) return null;
      const h = hullSize(wc.hull.stations);
      return { stemZ: h.stemZ, transomZ: h.transomZ, beam: h.beam };
    })();
    const setCraft = (d: AircraftDef | null | undefined) => {
      def = d ?? null;
      const wc = watercraftOf(def);
      if (!wc) {
        hull = null;
        return;
      }
      const h = hullSize(wc.hull.stations);
      hull = { stemZ: h.stemZ, transomZ: h.transomZ, beam: h.beam };
    };
    const player: PlayerInfo = { x: 0, y: 0, z: 0, heading: 0, speed: 0, vx: 0, vy: 0, vz: 0, vessel: false, hull: null };
    const cam = new THREE.Vector3();
    const qn = new THREE.Quaternion();
    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const listener: WildlifeListener = { x: 0, y: 0, z: 0, rx: 1, ry: 0, rz: 0, paused: false, dt: 0, gulls: wild.gulls.poses, gullCount: wild.gulls.plan.gulls.length };
    const frame = { t: 0, waveTime: 0, trafficT: 0, dt: 0, camX: 0, camY: 0, camZ: 0, player: player as PlayerInfo | null, viewportHeight: 900 };

    return {
      update(f) {
        if (f.def && f.def !== def) setCraft(f.def);
        const atmo = ctx.atmosphere;
        syncLighting(wild.shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
        clock.advance(f.dt, f.paused);
        f.camera.getWorldPosition(cam);
        const s = f.state;
        qn.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w);
        fwd.set(0, 0, -1).applyQuaternion(qn);
        player.x = s.position.x;
        player.y = s.position.y;
        player.z = s.position.z;
        player.heading = ((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360;
        player.vx = s.velocity.x;
        player.vy = s.velocity.y;
        player.vz = s.velocity.z;
        player.vessel = !!(hull && s.vessel);
        player.hull = player.vessel ? hull : null;
        player.speed = player.vessel && s.vessel ? s.vessel.speedMs : Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
        frame.player = s.crash && !player.vessel ? null : player;
        frame.t = f.waveTime + offset;
        frame.waveTime = f.waveTime;
        frame.trafficT = clock.t;
        frame.dt = f.paused ? 0 : Math.max(0, Math.min(0.1, Number.isFinite(f.dt) ? f.dt : 0));
        frame.camX = cam.x;
        frame.camY = cam.y;
        frame.camZ = cam.z;
        frame.viewportHeight = ctx.renderer.domElement.height || 900;
        wild.update(frame);
        // the listener: the camera, its right-hand side for panning
        const e = f.camera.matrixWorld.elements;
        right.set(e[0], e[1], e[2]);
        listener.x = cam.x;
        listener.y = cam.y;
        listener.z = cam.z;
        listener.rx = right.x;
        listener.ry = right.y;
        listener.rz = right.z;
        listener.paused = f.paused;
        listener.dt = frame.dt;
        audio.update(listener);
      },
      onAction(a) {
        if (a === 'mute') audio.toggleMute();
      },
      onReset() {
        wild.reset();
      },
      onAircraftChange(d) {
        setCraft(d);
        wild.reset();
      },
      stats: () => ({ ...wild.stats(), audio: audio.stats(), whales: wild.whaleInfo(frame.t), podCentres: wild.podInfo(frame.t) }),
      dispose() {
        audio.dispose();
        wild.dispose();
      },
    };
  },
};
export default mod;
