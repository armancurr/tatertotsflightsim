/**
 * Ships and boats (owned by src/world/traffic): the Port Chateau marina and its moored boats,
 * sailing yachts, motor yachts, fishing boats, the harbour launch, the bay ferry and its
 * terminals, a container ship and a tanker offshore, boats on Tater Lake; wakes, spray, lights.
 * Traffic time runs with the sim (stops while paused); URL `?tt=<s>` sets its start.
 *
 * Also registers the harbour as physics obstacles (src/world/traffic/harbourObstacles.ts): the
 * marina's quay, breakwaters, pontoons, fingers, piles and moored boats at once, the ferry terminals
 * once the sea plan is built — what you see is what you hit, for boats and aircraft alike.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { createShips } from '../../world/traffic/ships';
import { createTrafficClock, parseTrafficTime } from '../../world/traffic/clock';
import { nightFactor, sunElevationDeg, syncLighting } from '../../world/traffic/daylight';
import { compileTraffic } from '../../world/traffic/compile';
import { createHarbourObstacles } from '../../world/traffic/harbourObstacles';
import { portMarina } from '../../world/port';
import type { SystemModule } from './types';

const search = (): string => {
  try {
    return location.search;
  } catch {
    return '';
  }
};

const mod: SystemModule = {
  name: 'ships',
  order: 44,
  create(ctx) {
    const ships = createShips();
    ctx.scene.add(ships.group);
    // the harbour is solid from the first frame (a boat starts moored in the marina)
    const harbour = createHarbourObstacles(portMarina());
    ctx.env.registerObstacleSource((x, z) => harbour.top(x, z));
    let terminalsSet = false;
    const syncTerminals = () => {
      if (terminalsSet || !ships.plan) return;
      harbour.setTerminals(ships.plan.terminals);
      terminalsSet = true;
    };
    const clock = createTrafficClock(parseTrafficTime(search()) ?? CONFIG.world.traffic.startTime);
    const cam = new THREE.Vector3();
    const frame = { camX: 0, camY: 0, camZ: 0, t: 0, waveTime: 0, dt: 0, night: 0, viewportHeight: 900 };
    const fill = (camera: THREE.Camera, time: number, dt: number) => {
      camera.getWorldPosition(cam);
      const atmo = ctx.atmosphere;
      syncLighting(ships.shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
      frame.camX = cam.x;
      frame.camY = cam.y;
      frame.camZ = cam.z;
      frame.t = clock.t;
      frame.waveTime = time;
      frame.dt = dt;
      frame.night = nightFactor(sunElevationDeg(atmo.sunDirection.y));
      frame.viewportHeight = ctx.renderer.domElement.height || 900;
      return frame;
    };
    return {
      async ready(camera) {
        // the sea plan and the models build in slices, yielding to the page between them
        while (!ships.build(8)) await new Promise((r) => setTimeout(r, 0));
        syncTerminals();
        ships.update(fill(camera, 0, 0));
        await compileTraffic(ctx.renderer, ships.group, camera, ctx.scene);
      },
      update(f) {
        if (!ships.ready && !ships.build(4)) return;
        syncTerminals();
        const step = clock.advance(f.dt, f.paused);
        // the sea's wave clock (the drawn water and a floating hull run on it)
        ships.update(fill(f.camera, f.waveTime, step));
      },
      onReset() {
        ships.reset();
      },
      stats: () => ({ ...ships.stats(), trafficTime: Math.round(clock.t * 10) / 10, harbourObstacleSets: harbour.sets.length }),
      dispose: () => ships.dispose(),
    };
  },
};
export default mod;
