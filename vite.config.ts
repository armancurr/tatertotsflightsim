import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 8092,
    strictPort: true,
    // Agent worktrees live under .worktrees/ — never watch or scan them from the main server.
    watch: { ignored: ['**/.worktrees/**', '**/qa/**'] },
  },
  optimizeDeps: { entries: ['index.html', 'preview/*.html'] },
  preview: { host: '127.0.0.1', port: 8092, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
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
