/**
 * Opt-in runner for the long keyboard-pilot sorties (not part of `npm test`: a flown sortie takes
 * ~3 min of wall time and depends on every combat system being merged):
 *   npx vitest run -c tests/e2e/sortie.vitest.config.ts
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tests/e2e/*.sortie.ts'],
    environment: 'node',
    allowOnly: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
