import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    // Define separate projects for unit and integration tests
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*integration*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*integration*.test.ts'],
          // Container teardown (`docker stop` + `docker rm -v`) shares one Docker
          // daemon with every other suite in the run. While Oracle or SQL Server
          // is still pulling/extracting its image, removing a sibling container
          // and its data volume can take well over Vitest's 10s default, and the
          // `afterAll` hooks in these suites fail with "Hook timed out in 10000ms"
          // even though every test passed. Setup hooks keep their explicit
          // per-suite timeouts; this raises the floor for teardown.
          hookTimeout: 60_000,
        },
      },
    ],
  },
});