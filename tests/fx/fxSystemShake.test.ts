import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import fxModule from '../../src/game/systems/fx';
import { getAircraftDef } from '../../src/fleet';
import { createTrimmedState, FLAT_ENV } from '../../src/physics';
import type { SystemContext } from '../../src/game/systems/types';

/** Trimmed level flight at `kt` for the aircraft, and the fx system's camera shake there. */
async function shakeAt(id: string, kt: number, switchTo?: string) {
  let def = getAircraftDef(id);
  const ctx = { scene: new THREE.Scene(), env: FLAT_ENV, actions: { currentAircraft: () => def } } as unknown as SystemContext;
  const sys = await fxModule.create(ctx);
  if (switchTo) {
    def = getAircraftDef(switchTo);
    sys.onAircraftChange?.(def, {} as never);
  }
  const { state } = createTrimmedState({ altitudeM: 1500, iasKt: kt, headingDeg: 0, x: 0, z: 0, gearDown: false, flapsNotch: 0 }, FLAT_ENV, def.config);
  const v = sys.cameraShake!(state);
  sys.dispose?.();
  return v;
}

describe('fx system camera shake uses the aircraft being flown', () => {
  it('jets cruising well below their own Vne do not vibrate (no Cessna overspeed shake)', async () => {
    expect(await shakeAt('f16', 350)).toBeLessThan(0.02);
    expect(await shakeAt('a10', 250)).toBeLessThan(0.02);
  });
  it('after switching from the Cessna to the F-16, 350 kt is still smooth', async () => {
    expect(await shakeAt('c172rg', 350, 'f16')).toBeLessThan(0.02);
  });
  it('the Cessna still shakes past its own Vne', async () => {
    expect(await shakeAt('c172rg', 180)).toBeGreaterThan(0.2);
  });
});
