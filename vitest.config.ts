import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup-isolation.ts'],
    environment: 'node',
    testTimeout: 60000, // 60 seconds — CI runners are slower than local
    // metrics-monitor has its own vitest suite (cd metrics-monitor && npm test)
    exclude: ['**/node_modules/**', '**/dist/**', 'metrics-monitor/**'],
    server: {
      deps: {
        external: [/@silvia-odwyer\/photon-node/],
      },
    },
  },
  resolve: {
    // Preserve symlinks to avoid issues with monorepo package resolution
    preserveSymlinks: true,
  },
});
