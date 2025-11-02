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
        },
      },
    ],
  },
});