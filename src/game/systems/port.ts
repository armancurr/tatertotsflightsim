/**
 * The big-ship port and the aids to navigation (src/world/harbour): the cruise terminal and the
 * naval pier, the Gull Island lighthouse with its sweeping beams, the harbour lights on the marina's
 * breakwater heads and the lit channel, safe-water and cardinal buoys — three draw calls
 * (harbour/render.ts). Registers the piers, the buoys and the lighthouse as physics obstacles from the
 * first frame (what you see is what you hit), and the pier decks as landable decks.
 */
import * as THREE from 'three';
import { portWorks } from '../../world/harbour/layout';
import { navaids, navaidObstacles } from '../../world/harbour/navaids';
import { createPortObstacles } from '../../world/harbour/obstacles';
import { createPortRenderer, type PortFrame } from '../../world/harbour/render';
import { nightFactor, sunElevationDeg, syncLighting } from '../../world/traffic/daylight';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'port',
  order: 45,
  create(ctx) {
    const works = portWorks();
    const nav = navaids();
    const piers = createPortObstacles(works);
    const aids = navaidObstacles(nav);
    ctx.env.registerObstacleSource((x, z) => {
      const a = piers.top(x, z);
      const b = aids.top(x, z);
      return a > b ? a : b;
    });
    ctx.env.registerDeckSource((x, z) => piers.deckTop(x, z));
    const port = createPortRenderer({ works, navaids: nav });
    ctx.scene.add(port.group);
    const cam = new THREE.Vector3();
    const frame: PortFrame = { camX: 0, camY: 0, camZ: 0, waveTime: 0, night: 0, viewportHeight: 900 };
    const fill = (camera: THREE.Camera, waveTime: number): PortFrame => {
      camera.getWorldPosition(cam);
      const atmo = ctx.atmosphere;
      syncLighting(port.shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
      frame.camX = cam.x;
      frame.camY = cam.y;
      frame.camZ = cam.z;
      frame.waveTime = waveTime;
      frame.night = nightFactor(sunElevationDeg(atmo.sunDirection.y));
      frame.viewportHeight = ctx.renderer.domElement.height || 900;
      return frame;
    };
    return {
      async ready(camera) {
        while (!port.build(8)) await new Promise((r) => setTimeout(r, 0));
        port.update(fill(camera, 0));
      },
      update(f) {
        if (!port.ready && !port.build(4)) return;
        port.update(fill(f.camera, f.waveTime));
      },
      stats: () => ({ ...port.stats() }),
      dispose: () => port.dispose(),
    };
  },
};
export default mod;
