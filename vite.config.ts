import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Anchor ignores to THIS checkout, so a Vite server started inside an agent worktree
// (whose absolute path contains /.worktrees/) still watches its own files.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 8092,
    strictPort: true,
    // Agent worktrees live under .worktrees/ — never watch or scan them from the main server.
    watch: { ignored: [`${root}.worktrees/**`, `${root}qa/**`] },
  },
  optimizeDeps: { entries: ['index.html', 'preview/*.html'] },
  preview: { host: '127.0.0.1', port: 8092, strictPort: true },
  // Relative asset URLs are resolved against `base`: build with `--base=/<repository>/` for GitHub
  // project pages (see .github/workflows/pages.yml); workers use new URL(…, import.meta.url), so they
  // follow the base too.
  build: {
    target: 'es2022',
    // Three chunks: a tiny entry (WebGL 2 check + error screens), three.js (cached across releases)
    // and the game, loaded by the entry with a dynamic import.
    chunkSizeWarningLimit: 1600,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**'],
    environment: 'node',
    reporters: ['default'],
    // Fail loudly if anyone leaves a .only or .skip behind: every test must run.
    allowOnly: false,
  },
});
