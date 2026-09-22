/**
 * Entry point: boots the full simulator (src/game/app.ts wires physics, world,
 * atmosphere, aircraft, cameras, HUD, audio and effects together).
 */
import { startApp } from './game/app';

const container = document.getElementById('app')!;
const hudRoot = document.getElementById('hud')!;
startApp(container, hudRoot).catch((e) => {
  console.error('Flight Simulator failed to start', e);
});
