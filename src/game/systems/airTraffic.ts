/**
 * Other aircraft (owned by src/world/traffic): runway-36 circuit traffic (touch-and-goes, full
 * stops, go-arounds), GA crossing the area, a helicopter over Port Chateau, airliners at cruise
 * with contrails. Always ≥ `world.traffic.playerClearance` from the player; re-anchored on every
 * reset, teleport and aircraft change. Traffic time stops while paused; `?tt=<s>` sets its start.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { createAirTraffic } from '../../world/traffic/airTraffic';
import { createTrafficClock, parseTrafficTime } from '../../world/traffic/clock';
import { nightFactor, sunElevationDeg, syncLighting } from '../../world/traffic/daylight';
import type { PlayerRef } from '../../world/traffic/air';
import { compileTraffic } from '../../world/traffic/compile';
import type { SystemModule } from './types';

const search = (): string => {
  try {
    return location.search;
  } catch {
    return '';
  }
};

const mod: SystemModule = {
  name: 'airTraffic',
  order: 46,
  create(ctx) {
    const clock = createTrafficClock(parseTrafficTime(search()) ?? CONFIG.world.traffic.startTime);
    const player: PlayerRef = { x: 0, y: 0, z: 0, agl: 0, vx: 0, vz: 0 };
    let known = false;
    const air = createAirTraffic({ t0: clock.t, player: () => (known ? player : null) });
    ctx.scene.add(air.group);
    const cam = new THREE.Vector3();
    // re-anchor on the first frame (the player's real position) and after every reset/teleport
    let reanchor = true;
    const frame = { camX: 0, camY: 0, camZ: 0, t: 0, dt: 0, night: 0, viewportHeight: 900, fovDeg: 60, player: player as PlayerRef | null };
    const fill = (camera: THREE.PerspectiveCamera, dt: number) => {
      camera.getWorldPosition(cam);
      const atmo = ctx.atmosphere;
      syncLighting(air.shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
      frame.camX = cam.x;
      frame.camY = cam.y;
      frame.camZ = cam.z;
      frame.t = clock.t;
      frame.dt = dt;
      frame.night = nightFactor(sunElevationDeg(atmo.sunDirection.y));
      frame.viewportHeight = ctx.renderer.domElement.height || 900;
      frame.fovDeg = camera.fov;
      frame.player = known ? player : null;
      return frame;
    };
    return {
      async ready(camera) {
        while (!air.build(8)) await new Promise((r) => setTimeout(r, 0));
        air.update(fill(camera, 0));
        await compileTraffic(ctx.renderer, air.group, camera, ctx.scene);
      },
      update(f) {
        const p = f.state.position;
        player.x = p.x;
        player.y = p.y;
        player.z = p.z;
        player.agl = p.y - ctx.env.groundHeight(p.x, p.z);
        player.vx = f.state.velocity.x;
        player.vz = f.state.velocity.z;
        known = true;
        if (!air.ready && !air.build(4)) return;
        if (reanchor) {
          air.reanchor(clock.t, player);
          reanchor = false;
        }
        const step = clock.advance(f.dt, f.paused);
        air.update(fill(f.camera, step));
      },
      onReset() {
        reanchor = true;
      },
      onAircraftChange() {
        reanchor = true;
      },
      stats: () => ({ ...air.stats(), trafficTime: Math.round(clock.t * 10) / 10 }),
      dispose: () => air.dispose(),
    };
  },
};
export default mod;
