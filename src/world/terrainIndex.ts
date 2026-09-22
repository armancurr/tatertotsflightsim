/**
 * Render-side entry point of the world module (what src/game/app.ts imports):
 * the LOD terrain and the water surfaces. The pure world (heightfield,
 * landcover, layout, environment) is imported from its own modules.
 */
export { createTerrain, type Terrain, type TerrainOptions, type TerrainStats } from './terrain';
export { createWater, type Water, type WaterOptions } from './water';
