import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Each test boots an in-memory PGlite and hashes passwords with scrypt.
    testTimeout: 30_000,
  },
});
