/**
 * Discovers every `src/game/systems/*.ts` module (except this file and types.ts),
 * creates them in `order`, and fans the frame hooks out to them. Also measures
 * each system's CPU time per update for window.sim.perf.systems.
 */
import type * as THREE from 'three';
import type { AircraftState, Controls, InstrumentReadings } from '../../types';
import type { SimAction } from '../../input/controlSystem';
import type { SimSystem, SystemContext, SystemFrame, SystemModule } from './types';

export type { SystemContext, SystemFrame, SimSystem, SystemModule } from './types';

export interface Systems {
  ready(camera: THREE.PerspectiveCamera, timeoutMs: number): Promise<void>;
  readings(state: AircraftState, controls: Controls, dt: number): InstrumentReadings | null;
  cameraShake(state: AircraftState): number | null;
  update(f: SystemFrame): void;
  onAction(a: SimAction): void;
  onReset(which: 'runway' | 'approach' | 'teleport'): void;
  onResize(): void;
  /** Smoothed CPU ms per system update. */
  timings(): Record<string, number>;
  stats(): Record<string, Record<string, unknown>>;
  names(): string[];
  dispose(): void;
}

function disabledFromUrl(): Set<string> {
  try {
    const v = new URLSearchParams(location.search).get('no');
    return new Set(v ? v.split(',').map((s) => s.trim()) : []);
  } catch {
    return new Set();
  }
}

/** Loads the system modules (Vite glob). Exported for tests. */
export function discoverSystemModules(): SystemModule[] {
  const found = import.meta.glob<{ default: SystemModule }>(['./*.ts', '!./index.ts', '!./types.ts'], { eager: true });
  return Object.values(found)
    .map((m) => m.default)
    .filter((m): m is SystemModule => !!m && typeof m.create === 'function')
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export async function createSystems(ctx: SystemContext, modules: SystemModule[] = discoverSystemModules(), disabled: Set<string> = disabledFromUrl()): Promise<Systems> {
  const list: { name: string; sys: SimSystem; ms: number }[] = [];
  for (const m of modules) {
    if (disabled.has(m.name)) continue;
    try {
      list.push({ name: m.name, sys: await m.create(ctx), ms: 0 });
    } catch (e) {
      console.error(`[systems] ${m.name} failed to start`, e);
    }
  }
  const safe = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error(`[systems] ${name} threw`, e);
    }
  };
  return {
    async ready(camera, timeoutMs) {
      const all = Promise.all(list.map((s) => s.sys.ready?.(camera) ?? Promise.resolve()));
      await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
    },
    readings(state, controls, dt) {
      for (const s of list) if (s.sys.readings) return s.sys.readings(state, controls, dt);
      return null;
    },
    cameraShake(state) {
      let v: number | null = null;
      for (const s of list) {
        if (!s.sys.cameraShake) continue;
        const x = s.sys.cameraShake(state);
        if (Number.isFinite(x)) v = v === null ? x : Math.max(v, x);
      }
      return v;
    },
    update(f) {
      for (const s of list) {
        if (!s.sys.update) continue;
        const t0 = performance.now();
        safe(s.name, () => s.sys.update!(f));
        s.ms += (performance.now() - t0 - s.ms) * 0.05;
      }
    },
    onAction: (a) => list.forEach((s) => s.sys.onAction && safe(s.name, () => s.sys.onAction!(a))),
    onReset: (w) => list.forEach((s) => s.sys.onReset && safe(s.name, () => s.sys.onReset!(w))),
    onResize: () => list.forEach((s) => s.sys.onResize && safe(s.name, () => s.sys.onResize!())),
    timings: () => Object.fromEntries(list.map((s) => [s.name, Math.round(s.ms * 1000) / 1000])),
    stats: () => Object.fromEntries(list.filter((s) => s.sys.stats).map((s) => [s.name, s.sys.stats!()])),
    names: () => list.map((s) => s.name),
    dispose: () => list.slice().reverse().forEach((s) => s.sys.dispose && safe(s.name, () => s.sys.dispose!())),
  };
}
