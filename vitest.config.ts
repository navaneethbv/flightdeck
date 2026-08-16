import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['test/setup.ts'],
    globalSetup: ['./test/global-teardown.ts'],
  },
});
