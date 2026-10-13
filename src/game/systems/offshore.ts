/**
 * Offshore scenery (src/world/offshore): the "Tater Alpha" oil platform with its burning flare and
 * landable helideck, and the Tater Bank wind farm with its substation.
 *
 * Physics: the platform and the turbines register obstacle sources (solid for aircraft and hulls:
 * legs, topside, derrick, cranes, flare boom; towers, nacelles and the rotors' swept discs); the
 * helideck registers as a landable DECK (`env.registerDeckSource`) — the JetRanger's skids stand on
 * it. Render: the platform is one LOD'd mesh + the flame + its glow on the sea at night; the farm is
 * two instanced meshes (static parts, rotors) + the substation; every light (aviation obstruction
 * lights, helideck perimeter, deck lights, the turbines' synchronised red flashers, the flare's
 * halo) is one shared point-sprite buffer. ~7 draw calls in all.
 *
 * The turbines face the sea's wind (CONFIG.world.water, or env.wind when present) and turn at a
 * speed that follows it (windFarm.ts). `window.sim.debug().systems.offshore` has the numbers.
 */
import * as THREE from 'three';
import { terrainHeight } from '../../world/heightfield';
import { nightFactor, sunElevationDeg, syncLighting } from '../../world/traffic/daylight';
import { createLightingUniforms, createPointMaterial } from '../../world/traffic/materials';
import { PointBuffer } from '../../world/traffic/points';
import { createPlatformPhysics, platformFrame } from '../../world/offshore/platform';
import { frameRotationY, localToWorld } from '../../world/offshore/sites';
import { createPlatformModel } from '../../world/offshore/platformModel';
import { createWindFarmPhysics, offshoreWind, rotorRpm, windFarmLayout } from '../../world/offshore/windFarm';
import { createWindFarmModel } from '../../world/offshore/windFarmModel';
import type { SystemModule } from './types';

const RED: [number, number, number] = [1, 0.05, 0.02];
const GREEN: [number, number, number] = [0.15, 1, 0.3];
const WARM: [number, number, number] = [1, 0.72, 0.42];
const WHITE: [number, number, number] = [1, 0.95, 0.85];
const YELLOW: [number, number, number] = [1, 0.8, 0.1];

/** Aviation obstruction lights flash together: on for 1 s of every 2 s (30 per minute). */
export const obstructionOn = (time: number): boolean => time - Math.floor(time / 2) * 2 < 1;
/** Marine lanterns on the corner turbines: Fl Y 5 s (a 1 s flash every 5 s), offset from the red ones. */
export const lanternOn = (time: number): boolean => {
  const t = (time + 0.5) % 5;
  return t >= 0 && t < 1;
};

const mod: SystemModule = {
  name: 'offshore',
  order: 53,
  create(ctx) {
    const env = ctx.env;
    // ── Physics ──
    const platform = createPlatformPhysics();
    env.registerObstacleSource((x, z) => platform.obstacleTop(x, z));
    env.registerDeckSource((x, z) => platform.helideckTop(x, z));
    const wind = offshoreWind(env);
    const farmPhys = createWindFarmPhysics(wind.fromDeg);
    env.registerObstacleSource((x, z) => farmPhys.obstacleTop(x, z));

    // ── Render ──
    const group = new THREE.Group();
    group.name = 'offshore';
    const frame = platformFrame();
    const depth = Math.max(10, -terrainHeight(frame.x, frame.z));
    const plat = createPlatformModel(depth);
    const platGroup = new THREE.Group();
    platGroup.name = 'offshore.platformSite';
    platGroup.position.set(frame.x, 0, frame.z);
    platGroup.rotation.y = frameRotationY(frame);
    platGroup.add(plat.root);
    group.add(platGroup);
    const farm = createWindFarmModel((x, z) => Math.max(5, -terrainHeight(x, z)), wind.fromDeg);
    group.add(farm.group);

    // lights: world positions precomputed (the platform doesn't move; nacelle lights follow the yaw)
    const shared = createLightingUniforms();
    const pointMat = createPointMaterial(shared);
    const platLights = plat.lights.map((l) => {
      const w = localToWorld(frame, l.x, l.z, { x: 0, z: 0 });
      return { x: w.x, y: l.y, z: w.z, kind: l.kind };
    });
    const nTurb = farm.turbines.length;
    const nacelle = new Float32Array(nTurb * 2 * 3);
    const v = new THREE.Vector3();
    const writeNacelle = () => {
      for (let i = 0; i < nTurb; i++)
        for (const s of [-1, 1] as const) {
          farm.nacelleLight(i, s, v);
          const k = (i * 2 + (s > 0 ? 1 : 0)) * 3;
          nacelle[k] = v.x;
          nacelle[k + 1] = v.y;
          nacelle[k + 2] = v.z;
        }
    };
    writeNacelle();
    // corner turbines carry the yellow marine lanterns (on the transition piece) and a mid-tower red light
    const corners = [0, 3, 12, 15].filter((i) => i < nTurb);
    const points = new PointBuffer(platLights.length + nTurb * 3 + corners.length + 16);
    const pointsObj = new THREE.Points(points.geometry, pointMat);
    pointsObj.name = 'offshore.lights';
    pointsObj.frustumCulled = false;
    pointsObj.renderOrder = -1;
    group.add(pointsObj);
    ctx.scene.add(group);

    // the halo sits in the flame's body, which leans ~18° downwind (local +X) from the tip
    const flareW = { x: platform.flareTip.x + frame.ux * 3, y: platform.flareTip.y, z: platform.flareTip.z + frame.uz * 3 };
    const sub = windFarmLayout().substation;
    let rpm = rotorRpm(wind.speedHub);
    let windFrom = wind.fromDeg;
    let night = 0;
    let lit = 0;
    let checkWind = 0;

    const writeLights = (time: number) => {
      points.reset();
      const n = night;
      const blink = obstructionOn(time) ? 1 : 0;
      // the flare's halo (always: a burning flare is visible by day from a distance, bright at night)
      const fl = plat.flareLevel();
      points.push(flareW.x, flareW.y + 8, flareW.z, 60 * (0.3 + 2.5 * n) * fl, 26 * (0.3 + 2.5 * n) * fl, 6 * (0.3 + 2.5 * n) * fl, 0, 5 + 4 * n, 3, 0);
      if (n > 0.01) {
        const k = 900 * n;
        for (const l of platLights) {
          switch (l.kind) {
            case 'obstruction':
              // platform obstruction lights are steady red (the turbines' flash)
              points.push(l.x, l.y, l.z, RED[0] * k * 1.4, RED[1] * k * 1.4, RED[2] * k * 1.4, 0, 0.6, 2.4, 0);
              break;
            case 'perimeter':
              points.push(l.x, l.y, l.z, GREEN[0] * k * 0.5, GREEN[1] * k * 0.5, GREEN[2] * k * 0.5, 0, 0.35, 1.6, 0);
              break;
            case 'flood':
              points.push(l.x, l.y, l.z, WHITE[0] * k * 1.6, WHITE[1] * k * 1.6, WHITE[2] * k * 1.6, 0, 1.0, 2.2, 0);
              break;
            case 'deck':
              points.push(l.x, l.y, l.z, WARM[0] * k * 0.3, WARM[1] * k * 0.3, WARM[2] * k * 0.3, 0, 0.4, 1.6, 0);
              break;
            case 'status':
              points.push(l.x, l.y, l.z, WARM[0] * k * 0.35, WARM[1] * k * 0.35, WARM[2] * k * 0.35, 0, 0.5, 1.6, 0);
              break;
          }
        }
        if (blink) {
          const kr = k * 6;
          for (let i = 0; i < nTurb * 2; i++) points.push(nacelle[i * 3], nacelle[i * 3 + 1], nacelle[i * 3 + 2], RED[0] * kr, RED[1] * kr, RED[2] * kr, 0, 1.6, 3, 0);
          // mid-tower obstruction lights (steady below the flashers on tall turbines — lit with them here)
          for (let i = 0; i < nTurb; i++) {
            const t = farm.turbines[i];
            points.push(t.x, 80, t.z - 3.8, RED[0] * k, RED[1] * k, RED[2] * k, 0, 0.6, 2, 0);
          }
        }
        if (lanternOn(time)) {
          for (const i of corners) {
            const t = farm.turbines[i];
            points.push(t.x, 23.8, t.z, YELLOW[0] * k * 1.2, YELLOW[1] * k * 1.2, YELLOW[2] * k * 1.2, 0, 0.7, 2.2, 0);
          }
        }
        // substation: steady red on its crane, warm deck lights
        points.push(sub.x, 42, sub.z, RED[0] * k, RED[1] * k, RED[2] * k, 0, 0.8, 2.2, 0);
        for (const [dx, dz] of [[-17, -13], [17, -13], [17, 13], [-17, 13]]) points.push(sub.x + dx, 25.5, sub.z + dz, WARM[0] * k * 0.6, WARM[1] * k * 0.6, WARM[2] * k * 0.6, 0, 0.6, 1.8, 0);
      }
      lit = points.count;
      points.commit();
    };

    const refreshWind = () => {
      const w = offshoreWind(env);
      rpm = rotorRpm(w.speedHub);
      if (Math.abs(w.fromDeg - windFrom) > 0.5) {
        windFrom = w.fromDeg;
        farm.setWind(windFrom);
        farmPhys.setWindFrom(windFrom);
        writeNacelle();
      }
    };

    return {
      update(f) {
        const atmo = ctx.atmosphere;
        syncLighting(shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
        night = nightFactor(sunElevationDeg(atmo.sunDirection.y));
        pointMat.uniforms.uHalfHeight.value = (ctx.renderer.domElement.height || 900) / 2;
        // the wind may change (env.wind): look again every few seconds
        if ((checkWind -= f.dt) <= 0) {
          checkWind = 5;
          refreshWind();
        }
        plat.update(f.time, night);
        farm.update(f.paused ? 0 : f.dt, rpm, night);
        writeLights(f.time);
      },
      stats: () => ({
        windFromDeg: Math.round(windFrom),
        rotorRpm: Math.round(rpm * 100) / 100,
        yawDeg: Math.round(farm.yawDeg),
        night: Math.round(night * 100) / 100,
        lights: lit,
        flare: Math.round(plat.flareLevel() * 100) / 100,
        helideck: { x: Math.round(platform.helideck.x * 10) / 10, y: platform.helideck.y, z: Math.round(platform.helideck.z * 10) / 10 },
        platformTris: plat.triangles(0),
        farmTris: farm.triangles(),
      }),
      dispose() {
        ctx.scene.remove(group);
        plat.dispose();
        farm.dispose();
        points.dispose();
        pointMat.dispose();
      },
    };
  },
};
export default mod;
