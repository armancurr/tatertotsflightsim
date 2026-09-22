/**
 * Entry point. The full simulator lives in src/game/app.ts; until every
 * wave-1 renderer module has landed, an interim build (real physics, controls
 * and cameras with stand-in visuals) is served so the sim can be flown early.
 */
import { startPrototype } from './game/prototype';

const container = document.getElementById('app')!;
const hudRoot = document.getElementById('hud')!;
startPrototype(container, hudRoot);
